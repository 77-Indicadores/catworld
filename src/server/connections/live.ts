/**
 * Leitura de fontes LIVE independente do provider da conexao (postgres | mssql).
 * Rotas de tabelas/export/OData usavam executePostgresReadOnly direto, entao uma
 * fonte live MSSQL simplesmente falhava. Aditivo: Postgres continua igual.
 */
import { ApiError } from "@/server/http";
import { executePostgresReadOnly, quotedPgTable, type PgConnection } from "./postgres";
import { executeMssqlReadOnly, quotedMssqlTable, type MssqlConnection } from "./mssql";

export type LiveConnection = (PgConnection & MssqlConnection) & { provider?: string };

export const isMssqlConnection = (c: { provider?: string }) => c.provider === "mssql";

/**
 * firebird-ftp NAO suporta modo "live" (decisao explicita, docs/firebird-ftp-provider.md): materializar
 * (download+gbak, pode levar minutos) numa consulta ad-hoc de toda leitura seria uma UX ruim, e nao existe
 * "renovar TTL" para uma leitura unica de passagem (o TTL so faz sentido para uma fonte "extract" agendada,
 * onde `refreshDatasetSource` chama `renewMaterialization` durante a rodada). `createDatasetSource` (sources.ts)
 * ja recusa 400 na criacao; esta funcao e a segunda linha de defesa caso uma fonte live aponte, de algum jeito,
 * para uma conexao firebird-ftp (ex.: dado antigo, edicao direta no banco).
 */
export function assertLiveSupported(c: { provider?: string }): void {
  if (c.provider === "firebird-ftp") {
    throw new ApiError(400, "LIVE_NOT_SUPPORTED_FOR_PROVIDER", "Fontes live nao sao suportadas para conexoes firebird-ftp; use uma fonte extract agendada");
  }
}

export function liveQuotedTable(c: { provider?: string }, schema: string, table: string): string {
  assertLiveSupported(c);
  return isMssqlConnection(c) ? quotedMssqlTable(schema, table) : quotedPgTable(schema, table);
}

export function liveQuoteIdent(c: { provider?: string }, name: string): string {
  assertLiveSupported(c);
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
  assertLiveSupported(c);
  return isMssqlConnection(c)
    ? executeMssqlReadOnly(c, sql, timeout, limit, offset, normalize, orderBy)
    : executePostgresReadOnly(c, sql, timeout, limit, offset, normalize, orderBy);
}

/** Pagina de uma fonte live com o SQL base ja no dialeto da origem. */
export async function liveCount(c: LiveConnection, baseExpr: string): Promise<number> {
  const r = await executeLiveReadOnly(c, `SELECT COUNT(*) AS cnt FROM ${baseExpr}`, 60, 1);
  return Number((r.rows[0] as { cnt?: unknown } | undefined)?.cnt ?? 0);
}
