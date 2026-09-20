/**
 * Leitura de fontes LIVE independente do provider da conexao (postgres | mssql).
 * Rotas de tabelas/export/OData usavam executePostgresReadOnly direto, entao uma
 * fonte live MSSQL simplesmente falhava. Aditivo: Postgres continua igual.
 */
import { executePostgresReadOnly, quotedPgTable, type PgConnection } from "./postgres";
import { executeMssqlReadOnly, quotedMssqlTable, type MssqlConnection } from "./mssql";

export type LiveConnection = (PgConnection & MssqlConnection) & { provider?: string };

export const isMssqlConnection = (c: { provider?: string }) => c.provider === "mssql";

export function liveQuotedTable(c: { provider?: string }, schema: string, table: string): string {
  return isMssqlConnection(c) ? quotedMssqlTable(schema, table) : quotedPgTable(schema, table);
}

export function liveQuoteIdent(c: { provider?: string }, name: string): string {
  return isMssqlConnection(c) ? `[${name.replaceAll("]", "]]")}]` : `"${name.replaceAll('"', '""')}"`;
}

export async function executeLiveReadOnly(
  c: LiveConnection,
  sql: string,
  timeout = 30,
  limit = 10000,
  offset = 0,
  normalize = false,
  orderBy?: string,
) {
  return isMssqlConnection(c)
    ? executeMssqlReadOnly(c, sql, timeout, limit, offset, normalize, orderBy)
    : executePostgresReadOnly(c, sql, timeout, limit, offset, normalize, orderBy);
}

/** Pagina de uma fonte live com o SQL base ja no dialeto da origem. */
export async function liveCount(c: LiveConnection, baseExpr: string): Promise<number> {
  const r = await executeLiveReadOnly(c, `SELECT COUNT(*) AS cnt FROM ${baseExpr}`, 60, 1);
  return Number((r.rows[0] as { cnt?: unknown } | undefined)?.cnt ?? 0);
}
