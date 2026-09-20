import { getStorageConnection } from "@/server/storage/connection";

/** Sonda do storage PADRAO, qualquer que seja o provider (postgres | sqlserver). Lanca se nao responder. */
export async function probeStorage(): Promise<{ latencyMs: number; database?: string }> {
  const started = Date.now();
  const conn = await getStorageConnection(null);
  const dbExpr = conn.provider === "postgres" ? "current_database()" : "DB_NAME()";
  const rows = await conn.query<{ database_name?: string }>(`SELECT 1 AS ok, ${dbExpr} AS database_name`);
  return { latencyMs: Date.now() - started, database: rows[0]?.database_name };
}
