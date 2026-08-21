/**
 * Storage pool routing — returns a mssql ConnectionPool for the given StorageServer.
 * Falls back to the default Azure SQL Server (CATWORLD_MSSQL_URL) when storageServerId is null.
 */
import sql from "mssql";
import { prisma } from "@/server/db";
import { sqlPool } from "@/server/azure/sql";

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

/**
 * Returns the mssql ConnectionPool for the given storageServerId.
 * Pass null to use the default Azure SQL Server.
 */
export async function getStoragePool(storageServerId: string | null | undefined): Promise<sql.ConnectionPool> {
  if (!storageServerId) return sqlPool();

  if (!poolCache.has(storageServerId)) {
    const server = await prisma.storageServer.findUniqueOrThrow({
      where: { id: storageServerId },
      select: { id: true, url: true, name: true },
    });

    const pool = new sql.ConnectionPool(parseMssqlUrl(server.url));
    pool.on("error", () => { poolCache.delete(storageServerId); });

    const promise = pool
      .connect()
      .catch((err) => { poolCache.delete(storageServerId); throw err; });

    poolCache.set(storageServerId, promise);
  }

  return poolCache.get(storageServerId)!;
}
