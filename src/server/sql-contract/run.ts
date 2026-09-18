/**
 * Ponto de entrada unico para executar T-SQL do usuario contra o STORAGE de um
 * dataset, qualquer que seja o provider (MSSQL ou Postgres). Roteamento e
 * contrato de traducao/resultado ficam aqui, nao repetidos em cada rota.
 */
import { executeReadOnly } from "@/server/azure/sql";
import { getStorageConnection } from "@/server/storage/connection";

export type QueryResult = Awaited<ReturnType<typeof executeReadOnly>>;

export async function runStorageQuery(opts: {
  principal: string;
  sql: string;
  timeout: number;
  limit: number;
  offset?: number;
  schemas: string[];
  storageServerId: string | null;
  normalize?: boolean;
}): Promise<QueryResult> {
  const conn = await getStorageConnection(opts.storageServerId);
  if (conn.provider === "postgres") {
    const { executeReadOnlyPg } = await import("@/server/storage/pg-query");
    const { PgStorageConnection } = await import("@/server/storage/pg-storage");
    return executeReadOnlyPg(
      conn as InstanceType<typeof PgStorageConnection>,
      opts.sql,
      opts.timeout,
      opts.limit,
      opts.schemas,
      opts.offset ?? 0,
      opts.normalize ?? false,
    );
  }
  return executeReadOnly(opts.principal, opts.sql, opts.timeout, opts.limit, opts.schemas, opts.offset ?? 0, 120, opts.storageServerId, opts.normalize ?? false);
}
