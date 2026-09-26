/**
 * Job CONNECTION_MATERIALIZE: baixa+descompacta e anexa o arquivo Firebird de uma `Connection` do tipo
 * `firebird-ftp`, no máximo uma vez por versão de arquivo remoto. Ver docs/firebird-ftp-provider.md.
 *
 * IMPORTANTE (confirmado testando contra o backup real do TMK, 2026-09-22): o arquivo dentro do zip NÃO é um
 * backup lógico do `gbak` — é uma cópia bruta do `.fdb` ao vivo (ODS 13 = Firebird 4.0/5.0; `gbak -c` falha
 * nele com "expected backup description record"). Por isso não existe passo de "restaurar": o pipeline é só
 * baixar, descompactar e anexar DIRETO no arquivo extraído. O motor da imagem precisa ser Firebird 5.x (o
 * Firebird 3.0 do apt do Debian, ODS 12, não abre um arquivo ODS 13 — "Wrong ODS version, expected 12,
 * encountered 13"); Debian bookworm não empacota Firebird 5, então a imagem instala pelo tarball oficial
 * (github.com/FirebirdSQL/firebird/releases), não pelo apt.
 *
 * Simplificação adicional: um único servidor Firebird atende vários `.fdb` ao mesmo tempo — um cliente conecta
 * direto pelo caminho do arquivo, sem alias. Este job NUNCA sobe ou derruba um processo de servidor; ele só
 * cria/apaga arquivos `.fdb` no servidor único e sempre-no-ar da imagem (`CATWORLD_FIREBIRD_HOST`/`_PORT`).
 * `ConnectionMaterialization.firebirdHost/Port` guardam esse valor fixo mesmo assim, para o dia em que o
 * servidor Firebird rodar num host separado.
 *
 * Trava: CAS otimista em `status` (nunca um advisory lock/transação Postgres segurando por vários minutos —
 * isso prenderia uma conexão do pool pelo tempo do download inteiro). Uma materialização "presa" (worker morto
 * no meio) destrava sozinha depois de `STALE_MATERIALIZING_MS`.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, rm, stat as fsStat, readdir } from "node:fs/promises";
import { join } from "node:path";
// Import de namespace, nao default — ver nota em firebird.ts (default resolve undefined sob esbuild/tsx).
import * as Firebird from "node-firebird";
import { prisma } from "@/server/db";
import { env } from "@/server/env";
import { decryptSecret } from "@/server/security/crypto";
import { downloadRemoteFile, remoteFileSignature, statRemoteFile, type FtpCredentials } from "./ftp-watch";
import type { FirebirdEndpoint } from "./firebird";

export type FirebirdFtpConfig = {
  /** pollMinutes: intervalo (minutos) entre checagens de "o arquivo remoto mudou?" — ver enqueueDueFirebirdFtpRefreshes
   * em sources.ts. Configurável por conexão porque a frequência real de chegada do backup varia por cliente (a
   * Jacy manda 1x/dia; outro cliente pode mandar de hora em hora). Ausente = DEFAULT_FIREBIRD_POLL_MINUTES. */
  ftp: { host: string; port?: number; remotePath: string; filePattern: string; pollMinutes?: number };
  firebird?: { innerFilePattern?: string; charset?: string };
};

export const DEFAULT_FIREBIRD_POLL_MINUTES = 60;

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
 * ERPs Firebird antigos (Poliview e afins) costumam ter procedures que chamam UDFs externas (bibliotecas
 * .so/.dll do servidor Firebird original do cliente, tipo `ib_udf`/uma lib própria) que NUNCA fazem parte do
 * `.fdb` em si — o backup traz só o banco, não os binários de UDF do servidor. Resultado real, visto contra o
 * backup da Jacy Construtora (2026-09-26): qualquer procedure que dependesse (direta ou indiretamente) de
 * INCDATE ou DIV falhava com "Function ... is not defined, module name or entrypoint could not be found".
 *
 * Em vez de tentar levar a biblioteca binária original (não temos acesso a ela, e nem faria sentido — é
 * específica do SO/arch do servidor do cliente), decompilamos o BLR das procedures que as chamavam
 * (RDB$PROCEDURES.RDB$PROCEDURE_SOURCE, texto puro no catálogo) para entender exatamente a semântica:
 *   INCDATE(d TIMESTAMP, anos INTEGER, meses INTEGER, dias INTEGER) RETURNS TIMESTAMP — soma anos/meses/dias
 *   DIV(a INTEGER, b INTEGER) RETURNS DOUBLE PRECISION — divisão em ponto flutuante de dois inteiros
 * (assinaturas confirmadas via RDB$FUNCTION_ARGUMENTS). As duas têm equivalente exato e nativo no Firebird
 * (DATEADD, CAST) desde a versão 2.1 — não precisam de UDF nenhuma.
 *
 * Isto só redefine a função DENTRO do .fdb EFÊMERO que acabamos de materializar (nunca o servidor original do
 * cliente): é seguro porque esse arquivo é uma cópia descartável, recriada a cada materialização. Só substitui
 * quando a função já existe como EXTERNAL com a mesma aridade esperada — nunca cria uma função nova do zero
 * nem mexe numa já nativa/PSQL, para não arriscar chocar com algo específico de outro cliente que use o mesmo
 * nome para algo diferente.
 */
const LEGACY_UDF_SHIMS = [
  {
    name: "INCDATE",
    argCount: 4,
    ddl: `CREATE OR ALTER FUNCTION INCDATE (D TIMESTAMP, ANOS INTEGER, MESES INTEGER, DIAS INTEGER)
RETURNS TIMESTAMP
AS
BEGIN
  RETURN DATEADD(DIAS DAY TO DATEADD(MESES MONTH TO DATEADD(ANOS YEAR TO D)));
END`,
  },
  {
    name: "DIV",
    argCount: 2,
    ddl: `CREATE OR ALTER FUNCTION DIV (A INTEGER, B INTEGER)
RETURNS DOUBLE PRECISION
AS
BEGIN
  RETURN CAST(A AS DOUBLE PRECISION) / B;
END`,
  },
  {
    // Mesmo achado de INCDATE/DIV, descoberto ao testar de verdade as 6 consultas do Poliview contra o .fdb
    // já com o shim de INCDATE/DIV aplicado (2026-09-26): S_BCO_MOVANALDET também chama uma ROUND externa
    // (módulo `rfunc`, entrypoint `fn_round` — mesma biblioteca de INCDATE), ROUND(valor DOUBLE PRECISION,
    // casas INTEGER) RETURNS DOUBLE PRECISION — arredondamento comum, sem nada de especial na semântica.
    // Implementado por aritmética pura (FLOOR/POWER), nunca chamando o ROUND nativo do Firebird de dentro do
    // próprio corpo: mesmo o texto sendo idêntico ("ROUND"), não dá pra ter certeza de que o compilador não
    // resolveria a chamada de volta para este catálogo (recursão) — não vale o risco de travar o motor.
    name: "ROUND",
    argCount: 2,
    ddl: `CREATE OR ALTER FUNCTION ROUND (V DOUBLE PRECISION, P INTEGER)
RETURNS DOUBLE PRECISION
AS
DECLARE VARIABLE FATOR DOUBLE PRECISION;
BEGIN
  FATOR = POWER(10, P);
  IF (V >= 0) THEN
    RETURN FLOOR(V * FATOR + 0.5) / FATOR;
  ELSE
    RETURN -FLOOR(-V * FATOR + 0.5) / FATOR;
END`,
  },
] as const;

async function patchLegacyUdfShims(db: Firebird.Database): Promise<void> {
  for (const shim of LEGACY_UDF_SHIMS) {
    try {
      const rows = await db.queryAsync<{ "RDB$MODULE_NAME": string | null; N: number }>(
        `SELECT F.RDB$MODULE_NAME, (SELECT COUNT(*) FROM RDB$FUNCTION_ARGUMENTS FA WHERE FA.RDB$FUNCTION_NAME = F.RDB$FUNCTION_NAME AND FA.RDB$ARGUMENT_POSITION > 0) AS N
         FROM RDB$FUNCTIONS F WHERE F.RDB$FUNCTION_NAME = ?`,
        [shim.name],
      );
      const row = rows[0];
      if (!row || !row["RDB$MODULE_NAME"] || Number(row.N) !== shim.argCount) continue; // não existe, já é nativa, ou aridade diferente da esperada — não mexe
      await db.queryAsync(shim.ddl);
    } catch (e) {
      // Best-effort: se o shim falhar, a conexão fica como estava antes (procedures que dependem da UDF
      // continuam quebradas, mas nada regride) — nunca deve derrubar a materialização inteira por causa disto.
      console.warn(`[firebird-materialize] falha ao aplicar shim de ${shim.name}:`, e instanceof Error ? e.message : e);
    }
  }
}

/**
 * Materializa (se necessário) a conexão `connectionId`. Devolve o endpoint pronto para uso. Nunca roda duas
 * vezes em paralelo para a mesma conexão (CAS); se outro worker já está materializando, esta chamada espera
 * (poll curto) em vez de duplicar o trabalho.
 */
/**
 * O registro de materialização (Postgres, sobrevive a deploy/restart) pode dizer "ready" com um TTL ainda
 * válido apontando para um .fdb que já não existe mais em disco: `CATWORLD_FIREBIRD_WORKDIR` é o disco LOCAL
 * do container, efêmero — um novo deploy/restart o zera, mas o registro no banco continua de pé até o TTL
 * expirar sozinho. Sem esta checagem, ensureMaterialized confiava cegamente no registro e devolvia um endpoint
 * morto (Firebird responde "I/O error ... Error while trying to open file") — bug real, reproduzido em produção
 * logo depois de um redeploy no meio de uma sessão de testes contra a Jacy Construtora (2026-09-25).
 */
async function materializedFileUsable(path: string): Promise<boolean> {
  return await fsStat(path).then(() => true).catch(() => false);
}

export async function ensureMaterialized(connectionId: string, creds: FtpCredentials, config: FirebirdFtpConfig): Promise<ReadyMaterialization> {
  const already = await currentMaterialization(connectionId);
  const remote = await statRemoteFile(creds, config.ftp.remotePath, config.ftp.filePattern);
  if (!remote) throw new Error(`nenhum arquivo bate "${config.ftp.filePattern}" em ${config.ftp.remotePath}`);
  const signature = remoteFileSignature(remote);

  if (already) {
    const row = await prisma.$queryRawUnsafe<{ remote_signature: string | null }[]>(
      `SELECT remote_signature FROM cw_connection_materializations WHERE connection_id = $1::uuid`, connectionId,
    );
    if (row[0]?.remote_signature === signature && await materializedFileUsable(already.endpoint.database)) return already; // nada mudou: reusa sem baixar nada
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
      if (row[0]?.remote_signature === signature && await materializedFileUsable(fresh.endpoint.database)) return fresh; // quem furou a fila já resolveu por nós
    }
  }

  const dir = workDirFor(connectionId);
  // Cada tentativa vai para uma subpasta própria: a materialização ANTERIOR (se houver) fica intacta noutra
  // subpasta e continua servível até a nova estar provada — nunca sobrescrevemos um .fdb que o servidor ainda
  // pode ter aberto para uma leitura em andamento.
  const attemptDir = join(dir, randomUUID());
  try {
    // O arquivo dentro do zip NÃO é backup logico do gbak: é uma copia bruta do .fdb ao vivo (confirmado contra
    // o backup real do TMK — ODS 13, Firebird 4.0/5.0; gbak -c falha nele com "expected backup description
    // record"). Por isso o pipeline e so baixar + descompactar + anexar DIRETO no arquivo extraido, sem
    // restore nenhum. Se um dia aparecer um cliente que manda backup logico de verdade, isso precisa de um
    // passo extra (detectar pelo cabecalho e rodar gbak so nesse caso) — nao assumido aqui.
    await assertDiskBudget(dir, remote.size * 5); // proporcao real observada no TMK: 1,7GB zip -> 6,5GB descompactado (~3,8x) + folga
    await mkdir(attemptDir, { recursive: true });

    const zipPath = join(attemptDir, "download.zip");
    await downloadRemoteFile(creds, remote.path, zipPath);

    await run("unzip", ["-o", zipPath, "-d", attemptDir]);
    const innerPattern = config.firebird?.innerFilePattern ?? "*";
    const extracted = (await readdir(attemptDir)).filter((n) => n !== "download.zip" && globToRegExp(innerPattern).test(n));
    if (extracted.length === 0) throw new Error(`nenhum arquivo dentro do zip bate "${innerPattern}"`);
    const fdbPath = join(attemptDir, extracted[0]!);

    const server = firebirdServer();
    const endpoint: FirebirdEndpoint = { host: server.host, port: server.port, database: fdbPath, user: server.user, password: server.password, charset: config.firebird?.charset };
    // Prova de vida antes de publicar como 'ready': anexa e faz uma consulta real ao catalogo — um arquivo
    // extraido mas ilegivel (zip truncado, ODS incompativel com o motor instalado) nunca pode passar por pronto.
    // Sem forcar wireCrypt (negociacao padrao do driver) — ver nota em firebird.ts sobre por que DISABLE quebra
    // contra o Firebird 5.x real que a imagem usa.
    await Firebird.attachAsync({ host: endpoint.host, port: endpoint.port, database: endpoint.database, user: endpoint.user, password: endpoint.password, encoding: (endpoint.charset ?? "UTF8") as never })
      .then((db) => db.queryAsync("SELECT 1 FROM RDB$DATABASE").then(() => patchLegacyUdfShims(db)).then(() => db.detachAsync()));

    const prevPath = already?.endpoint.database;
    await markReady(connectionId, signature, endpoint);
    await rm(zipPath, { force: true }); // so o zip; o .fdb extraido fica (e agora o "database" apontado por ready)
    if (prevPath && prevPath !== fdbPath) {
      // Só remover o arquivo/diretório antigo do disco — SEM `Firebird.dropAsync` (DROP DATABASE de verdade)
      // antes disso: já detachamos logo após a prova de vida acima (nada segue anexado nesse arquivo), então
      // o DROP não protege nada aqui, e um DROP DATABASE contra o motor único e compartilhado (docs/
      // firebird-ftp-provider.md secao 1) é caro/exclusivo o bastante para arriscar travar/derrubar o motor
      // para TODAS as conexões — suspeito (não confirmado por log de servidor, sem acesso a ele) de ter
      // deixado o motor inacessível em produção, 2026-09-25, logo após o primeiro DROP de um arquivo real
      // (os anteriores, testados nesta sessão, eram sempre contra referencias já mortas pelo bug do commit
      // anterior). rm() recursivo do diretório já apaga o .fdb e qualquer arquivo auxiliar dele.
      await rm(join(prevPath, ".."), { recursive: true, force: true }).catch((e) => console.warn(`[firebird-materialize] falha ao limpar materializacao anterior de ${connectionId}:`, e instanceof Error ? e.message : e));
    }

    return { endpoint, expiresAt: new Date(Date.now() + MATERIALIZATION_TTL_MS) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await markFailed(connectionId, message);
    await rm(attemptDir, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
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
      // Só apaga o diretório do disco — ver nota em ensureMaterialized sobre por que NÃO usar
      // Firebird.dropAsync (DROP DATABASE) aqui: nada segue anexado a um arquivo vencido, e um DROP DATABASE
      // contra o motor único e compartilhado é caro/exclusivo o bastante para arriscar travá-lo pra todo mundo.
      await rm(workDirFor(row.connection_id), { recursive: true, force: true }).catch(() => undefined);
      await prisma.$executeRawUnsafe(`UPDATE cw_connection_materializations SET status = 'idle', firebird_path = NULL, updated_at = now() WHERE connection_id = $1::uuid`, row.connection_id);
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
