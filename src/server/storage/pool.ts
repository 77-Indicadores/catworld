/**
 * Storage pool routing — returns a mssql ConnectionPool for the given StorageServer.
 * All URLs come from cw_storage_servers (managed via admin UI), never from env vars.
 *
 * Pass null/undefined to use the StorageServer marked as isDefault = true.
 */
import sql from "mssql";
import { prisma } from "@/server/db";
import { decryptSecret } from "@/server/security/crypto";

function parseMssqlUrl(url: string): sql.config {
  const withoutScheme = url.replace(/^sqlserver:\/\//i, "");
  const [hostPort, ...rest] = withoutScheme.split(";").filter(Boolean);
  const [server, port] = (hostPort ?? "").split(":");
  const params = Object.fromEntries(
    rest.map((part) => { const i = part.indexOf("="); return [part.slice(0, i).toLowerCase(), part.slice(i + 1)]; }),
  );
  return {
    server: server ?? "",
    port: port ? Number(port) : 1433,
    database: params.database,
    user: params.user,
    password: params.password,
    options: {
      encrypt: params.encrypt !== "false",
      trustServerCertificate: params.trustservercertificate === "true",
      packetSize: 16384,
    },
    requestTimeout: 600_000,
    connectionTimeout: 30_000,
    pool: { max: 10, min: 2, idleTimeoutMillis: 30_000 },
  };
}

const poolCache = new Map<string, Promise<sql.ConnectionPool>>();

async function getDefaultStorageServerId(): Promise<string> {
  const server = await prisma.storageServer.findFirstOrThrow({
    where: { isDefault: true },
    select: { id: true },
  });
  return server.id;
}

/**
 * Returns the mssql ConnectionPool for the given storageServerId.
 * Pass null/undefined to route to the default StorageServer.
 */
export async function getStoragePool(storageServerId: string | null | undefined): Promise<sql.ConnectionPool> {
  const id = storageServerId ?? await getDefaultStorageServerId();

  if (!poolCache.has(id)) {
    const server = await prisma.storageServer.findUniqueOrThrow({
      where: { id },
      select: { id: true, url: true, encryptedCredentials: true },
    });

    // encryptedCredentials tem precedência (armazena URL completa criptografada).
    // url é fallback legado (pode ser mascarada ou plaintext de registros antigos).
    let resolvedUrl: string | null = null;
    if (server.encryptedCredentials) {
      try { resolvedUrl = decryptSecret(server.encryptedCredentials); } catch { /* fallback abaixo */ }
    }
    if (!resolvedUrl) resolvedUrl = server.url;
    if (!resolvedUrl) throw new Error(`StorageServer ${id} has no url configured`);
    const pool = new sql.ConnectionPool(parseMssqlUrl(resolvedUrl));
    pool.on("error", () => { poolCache.delete(id); });

    const promise = pool
      .connect()
      .catch((err) => { poolCache.delete(id); throw err; });

    poolCache.set(id, promise);
  }

  return poolCache.get(id)!;
}
