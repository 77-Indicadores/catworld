/**
 * Vigia um arquivo remoto por FTP, genérico (não específico de Firebird): usado por qualquer provider de origem
 * "baseado em arquivo remoto" (hoje só firebird-ftp — ver docs/firebird-ftp-provider.md). Duas operações, ambas
 * puras em relação ao disco local:
 *
 *  - `statRemoteFile`: só `LIST`, nunca baixa. É o que permite decidir "mudou?" sem gastar rede/disco com um
 *    arquivo de gigabytes.
 *  - `downloadRemoteFile`: baixa para um caminho `.part` e só renumeia para o destino final no sucesso — o
 *    mesmo princípio de "staging nunca é o arquivo final" que já vale para o import do SQL Server: uma queda no
 *    meio do download nunca deixa um arquivo parcial se passando por completo.
 *
 * Credenciais chegam já desencriptadas pelo chamador (mesmo padrão de `postgres.ts`/`mssql.ts`: quem lê
 * `Connection.encryptedCredentials` é o call site em `sources.ts`, não este módulo).
 */
import { Client, FileInfo } from "basic-ftp";
import { rename, unlink } from "node:fs/promises";

export type FtpCredentials = {
  host: string;
  port?: number;
  user: string;
  password: string;
  secure?: boolean;
};

export type RemoteFileStat = {
  name: string;
  /** caminho completo remoto (dir + nome), para reusar em downloadRemoteFile. */
  path: string;
  size: number;
  /** null quando o servidor FTP não informa data de modificação para esse arquivo (alguns servidores não mandam em LIST). */
  mtime: Date | null;
};

/** "<tamanho>:<mtime ISO ou vazio>" — comparação estável para decidir se o arquivo remoto mudou desde a última materialização. */
export function remoteFileSignature(stat: Pick<RemoteFileStat, "size" | "mtime">): string {
  return `${stat.size}:${stat.mtime ? stat.mtime.toISOString() : ""}`;
}

function matchesPattern(name: string, pattern: string): boolean {
  // glob simples (só '*' e '?'), suficiente para "*.zip"/"*.PLV" — sem trazer uma lib de glob para isso.
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
  return re.test(name);
}

async function withClient<T>(creds: FtpCredentials, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client(30_000);
  try {
    await client.access({ host: creds.host, port: creds.port ?? 21, user: creds.user, password: creds.password, secure: creds.secure ?? false });
    return await fn(client);
  } finally {
    client.close();
  }
}

/**
 * Lista `remotePath` e devolve o arquivo mais recente (por mtime; se o servidor não informar mtime para nenhum
 * candidato, o último por ordem alfabética) cujo nome bate `pattern` (glob simples, ex.: "*.zip"). `null` se
 * nada casar — chamador decide se isso é erro (pasta vazia, ainda não chegou nada) ou não.
 */
export async function statRemoteFile(creds: FtpCredentials, remotePath: string, pattern: string): Promise<RemoteFileStat | null> {
  return withClient(creds, async (client) => {
    const list: FileInfo[] = await client.list(remotePath);
    const candidates = list
      .filter((f) => f.isFile && matchesPattern(f.name, pattern))
      .map((f) => ({
        name: f.name,
        path: remotePath.endsWith("/") ? `${remotePath}${f.name}` : `${remotePath}/${f.name}`,
        size: f.size,
        mtime: f.rawModifiedAt || f.modifiedAt ? new Date(f.modifiedAt ?? f.rawModifiedAt!) : null,
      }))
      .filter((f) => f.mtime === null || !Number.isNaN(f.mtime.getTime()));
    if (candidates.length === 0) return null;
    const withMtime = candidates.filter((f) => f.mtime !== null);
    if (withMtime.length > 0) return withMtime.sort((a, b) => b.mtime!.getTime() - a.mtime!.getTime())[0]!;
    return candidates.sort((a, b) => a.name.localeCompare(b.name)).at(-1)!;
  });
}

/**
 * Baixa `remoteFilePath` para `destPath`. Sempre passa por `<destPath>.part`: se o processo cair no meio (queda
 * de rede, worker morto), o `.part` fica órfão e `destPath` nunca existe pela metade — a próxima tentativa
 * limpa o `.part` velho e recomeça do zero (retomar um download parcial de FTP não é confiável o bastante para
 * arriscar um arquivo de gigabytes truncado sendo tratado como completo).
 */
export async function downloadRemoteFile(creds: FtpCredentials, remoteFilePath: string, destPath: string): Promise<void> {
  const partPath = `${destPath}.part`;
  await unlink(partPath).catch(() => undefined);
  try {
    await withClient(creds, async (client) => {
      await client.downloadTo(partPath, remoteFilePath);
    });
    await rename(partPath, destPath);
  } catch (e) {
    await unlink(partPath).catch(() => undefined);
    throw e;
  }
}
