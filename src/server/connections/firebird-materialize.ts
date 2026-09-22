/**
 * Job CONNECTION_MATERIALIZE: baixa+descompacta+restaura (gbak) o backup Firebird de uma `Connection` do tipo
 * `firebird-ftp`, no máximo uma vez por versão de arquivo remoto. Ver docs/firebird-ftp-provider.md.
 *
 * Simplificação (confirmada testando contra o Firebird 3.0.8 real): um único servidor Firebird atende vários
 * `.fdb` ao mesmo tempo — um cliente conecta direto pelo caminho do arquivo, sem alias. Este job NUNCA sobe ou
 * derruba um processo de servidor; ele só cria/apaga arquivos `.fdb` no servidor único e sempre-no-ar da
 * imagem (`CATWORLD_FIREBIRD_HOST`/`_PORT`). `ConnectionMaterialization.firebirdHost/Port` guardam esse valor
 * fixo mesmo assim, para o dia em que o servidor Firebird rodar num host separado.
 *
 * Trava: CAS otimista em `status` (nunca um advisory lock/transação Postgres segurando por 10-20+ minutos —
 * isso prenderia uma conexão do pool pelo tempo do download+gbak inteiro). Uma materialização "presa" (worker
 * morto no meio) destrava sozinha depois de `STALE_MATERIALIZING_MS`.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, rm, stat as fsStat, readdir } from "node:fs/promises";
import { join } from "node:path";
import Firebird from "node-firebird";
import { prisma } from "@/server/db";
import { env } from "@/server/env";
import { decryptSecret } from "@/server/security/crypto";
import { downloadRemoteFile, remoteFileSignature, statRemoteFile, type FtpCredentials } from "./ftp-watch";
import type { FirebirdEndpoint } from "./firebird";

export type FirebirdFtpConfig = {
  ftp: { host: string; port?: number; remotePath: string; filePattern: string };
  firebird?: { innerFilePattern?: string; charset?: string };
};

/** Quanto tempo uma materialização OK vale antes de outra fonte da mesma conexão ter que reconferir o FTP. */
export const MATERIALIZATION_TTL_MS = 15 * 60_000;
/** Uma materialização "materializing" mais velha que isso é considerada de um worker morto (destrava sozinha). */
const STALE_MATERIALIZING_MS = 30 * 60_000;

function firebirdServer(): { host: string; port: number; user: string; password: string } {
  const { CATWORLD_FIREBIRD_HOST, CATWORLD_FIREBIRD_PORT, CATWORLD_FIREBIRD_SYSDBA_PASSWORD } = env();
  if (!CATWORLD_FIREBIRD_SYSDBA_PASSWORD) {
    throw new Error("CATWORLD_FIREBIRD_SYSDBA_PASSWORD não configurada (necessária para conexões firebird-ftp)");
  }
  return { host: CATWORLD_FIREBIRD_HOST, port: CATWORLD_FIREBIRD_PORT, user: "sysdba", password: CATWORLD_FIREBIRD_SYSDBA_PASSWORD };
}

/** Tenta reivindicar a materialização desta conexão (CAS em `status`). `false` = outro worker já está nisso. */
async function tryClaim(connectionId: string): Promise<boolean> {
  const staleAt = new Date(Date.now() - STALE_MATERIALIZING_MS);
  await prisma.$executeRawUnsafe(
    `INSERT INTO cw_connection_materializations (connection_id, status, updated_at) VALUES ($1::uuid, 'materializing', now())
     ON CONFLICT (connection_id) DO UPDATE SET status = 'materializing', updated_at = now()
     WHERE cw_connection_materializations.status <> 'materializing' OR cw_connection_materializations.updated_at < $2`,
    connectionId, staleAt,
  );
  const rows = await prisma.$queryRawUnsafe<{ updated_at: Date }[]>(
    `SELECT updated_at FROM cw_connection_materializations WHERE connection_id = $1::uuid AND status = 'materializing'`,
    connectionId,
  );
  // Se o UPDATE do CAS não aplicou (outro worker já tinha 'materializing' fresco), updated_at não é "agora".
  return rows.length > 0 && Date.now() - rows[0]!.updated_at.getTime() < 5_000;
}

async function markFailed(connectionId: string, error: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE cw_connection_materializations SET status = 'failed', last_error = $2, updated_at = now() WHERE connection_id = $1::uuid`,
    connectionId, error.slice(0, 4000),
  );
}

async function markReady(connectionId: string, signature: string, endpoint: FirebirdEndpoint): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE cw_connection_materializations SET status = 'ready', remote_signature = $2, materialized_at = now(),
       expires_at = now() + ($3 || ' milliseconds')::interval, firebird_host = $4, firebird_port = $5, firebird_path = $6,
       last_error = NULL, updated_at = now() WHERE connection_id = $1::uuid`,
    connectionId, signature, String(MATERIALIZATION_TTL_MS), endpoint.host, endpoint.port, endpoint.database,
  );
}

export type ReadyMaterialization = { endpoint: FirebirdEndpoint; expiresAt: Date };

/** Renova o TTL enquanto uma fonte está lendo (mesmo princípio do heartbeat do lease de import). */
export async function renewMaterialization(connectionId: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE cw_connection_materializations SET expires_at = now() + ($2 || ' milliseconds')::interval, updated_at = now()
     WHERE connection_id = $1::uuid AND status = 'ready'`,
    connectionId, String(MATERIALIZATION_TTL_MS),
  );
}

/** Materialização pronta e não vencida para esta conexão, se houver — sem disparar trabalho nenhum. */
export async function currentMaterialization(connectionId: string): Promise<ReadyMaterialization | null> {
  const rows = await prisma.$queryRawUnsafe<{ firebird_host: string; firebird_port: number; firebird_path: string; expires_at: Date }[]>(
    `SELECT firebird_host, firebird_port, firebird_path, expires_at FROM cw_connection_materializations
     WHERE connection_id = $1::uuid AND status = 'ready' AND firebird_path IS NOT NULL AND expires_at > now()`,
    connectionId,
  );
  const r = rows[0];
  if (!r) return null;
  const { password } = firebirdServer();
  return {
    expiresAt: r.expires_at,
    endpoint: { host: r.firebird_host, port: r.firebird_port, database: r.firebird_path, user: "sysdba", password },
  };
}

function workDirFor(connectionId: string): string {
  return join(env().CATWORLD_FIREBIRD_WORKDIR, connectionId);
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries: string[];
  try { entries = await readdir(dir); } catch { return 0; }
  for (const name of entries) {
    const s = await fsStat(join(dir, name)).catch(() => null);
    if (s?.isFile()) total += s.size;
  }
  return total;
}

/** Nunca deixar o volume de restauração estourar em silêncio (mesmo princípio do resto do plano de confiabilidade). */
async function assertDiskBudget(dir: string, incomingBytes: number): Promise<void> {
  const used = await dirSize(env().CATWORLD_FIREBIRD_WORKDIR).catch(() => 0);
  const max = env().CATWORLD_FIREBIRD_MAX_DISK_BYTES;
  if (used + incomingBytes > max) {
    throw new Error(`espaço insuficiente para materializar (usado ${used}B + ${incomingBytes}B > teto ${max}B em ${dir}); configure CATWORLD_FIREBIRD_MAX_DISK_BYTES ou libere disco`);
  }
}

function run(cmd: string, args: string[], opts: { input?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`${cmd} saiu com código ${code}: ${stderr || stdout}`))));
    if (opts.input) { child.stdin.write(opts.input); child.stdin.end(); }
  });
}

function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
}

/**
 * Materializa (se necessário) a conexão `connectionId`. Devolve o endpoint pronto para uso. Nunca roda duas
 * vezes em paralelo para a mesma conexão (CAS); se outro worker já está materializando, esta chamada espera
 * (poll curto) em vez de duplicar o trabalho.
 */
export async function ensureMaterialized(connectionId: string, creds: FtpCredentials, config: FirebirdFtpConfig): Promise<ReadyMaterialization> {
  const already = await currentMaterialization(connectionId);
  const remote = await statRemoteFile(creds, config.ftp.remotePath, config.ftp.filePattern);
  if (!remote) throw new Error(`nenhum arquivo bate "${config.ftp.filePattern}" em ${config.ftp.remotePath}`);
  const signature = remoteFileSignature(remote);

  if (already) {
    const row = await prisma.$queryRawUnsafe<{ remote_signature: string | null }[]>(
      `SELECT remote_signature FROM cw_connection_materializations WHERE connection_id = $1::uuid`, connectionId,
    );
    if (row[0]?.remote_signature === signature) return already; // nada mudou: reusa sem baixar nada
  }

  for (let attempt = 0; attempt < 60; attempt++) {
    if (await tryClaim(connectionId)) break;
    if (attempt === 59) throw new Error("materialização de outra tentativa não terminou a tempo (timeout de espera)");
    await new Promise((r) => setTimeout(r, 5_000));
    const fresh = await currentMaterialization(connectionId);
    if (fresh) {
      const row = await prisma.$queryRawUnsafe<{ remote_signature: string | null }[]>(
        `SELECT remote_signature FROM cw_connection_materializations WHERE connection_id = $1::uuid`, connectionId,
      );
      if (row[0]?.remote_signature === signature) return fresh; // quem furou a fila já resolveu por nós
    }
  }

  const dir = workDirFor(connectionId);
  try {
    await assertDiskBudget(dir, remote.size * 2.2); // zip + descompactado, margem para o .fdb restaurado ser maior
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });

    const zipPath = join(dir, "download.zip");
    await downloadRemoteFile(creds, remote.path, zipPath);

    await run("unzip", ["-o", zipPath, "-d", dir]);
    const innerPattern = config.firebird?.innerFilePattern ?? "*";
    const extracted = (await readdir(dir)).filter((n) => n !== "download.zip" && globToRegExp(innerPattern).test(n));
    if (extracted.length === 0) throw new Error(`nenhum arquivo dentro do zip bate "${innerPattern}"`);
    const backupPath = join(dir, extracted[0]!);

    const server = firebirdServer();
    const fdbPath = join(dir, `${randomUUID()}.fdb`);
    // gbak -c: cria o banco do zero a partir do backup. -user/-password: sempre o SYSDBA nosso, nunca credencial do cliente.
    await run("gbak", ["-c", "-v", "-user", server.user, "-password", server.password, backupPath, fdbPath]);

    const endpoint: FirebirdEndpoint = { host: server.host, port: server.port, database: fdbPath, user: server.user, password: server.password, charset: config.firebird?.charset };
    // Prova de vida antes de publicar como 'ready' — um restore que "termina" mas produz um .fdb ilegível não pode passar.
    await Firebird.attachAsync({ host: endpoint.host, port: endpoint.port, database: endpoint.database, user: endpoint.user, password: endpoint.password, encoding: (endpoint.charset ?? "UTF8") as never, wireCrypt: Firebird.WIRE_CRYPT_DISABLE })
      .then((db) => db.detachAsync());

    // Materialização antiga (se houver) some do disco só depois que a nova está provada — nunca um intervalo sem nenhuma.
    const prevPath = already?.endpoint.database;
    await markReady(connectionId, signature, endpoint);
    await rm(zipPath, { force: true });
    await rm(backupPath, { force: true });
    if (prevPath && prevPath !== fdbPath) await dropFirebirdFile(server, prevPath).catch(() => undefined);

    return { endpoint, expiresAt: new Date(Date.now() + MATERIALIZATION_TTL_MS) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await markFailed(connectionId, message);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
}

async function dropFirebirdFile(server: { host: string; port: number; user: string; password: string }, database: string): Promise<void> {
  await Firebird.dropAsync({ host: server.host, port: server.port, database, user: server.user, password: server.password });
}

/** Chamado pela limpeza periódica (mesmo espírito de purgeExpiredUploadFiles/purgeLedger): materializações vencidas há tempo e sem fonte usando (nenhum renewMaterialization recente) têm o .fdb apagado do disco. */
export async function purgeExpiredMaterializations(graceMs = 10 * 60_000): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ connection_id: string; firebird_path: string }[]>(
    `SELECT connection_id, firebird_path FROM cw_connection_materializations
     WHERE status = 'ready' AND firebird_path IS NOT NULL AND expires_at < now() - ($1 || ' milliseconds')::interval`,
    String(graceMs),
  );
  let n = 0;
  for (const row of rows) {
    try {
      const server = firebirdServer();
      await dropFirebirdFile(server, row.firebird_path);
      await prisma.$executeRawUnsafe(`UPDATE cw_connection_materializations SET status = 'idle', firebird_path = NULL, updated_at = now() WHERE connection_id = $1::uuid`, row.connection_id);
      await rm(workDirFor(row.connection_id), { recursive: true, force: true }).catch(() => undefined);
      n++;
    } catch (e) {
      console.error(`[firebird-materialize] falha ao limpar ${row.connection_id}:`, e instanceof Error ? e.message : e);
    }
  }
  return n;
}

/** `Connection.encryptedCredentials` guarda { password } do FTP (mesmo formato de postgres.ts/mssql.ts). */
export function ftpCredsFromConnection(connection: { server: string; port: number | null; username: string; encryptedCredentials: string }): FtpCredentials {
  const { password } = JSON.parse(decryptSecret(connection.encryptedCredentials)) as { password: string };
  return { host: connection.server, port: connection.port ?? 21, user: connection.username, password };
}
