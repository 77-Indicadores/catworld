import { CW_DELETED_AT, type StorageConnection } from "./connection";

/**
 * Linhas excluídas na origem ficam na tabela com `cw_deleted_at` preenchido (soft delete,
 * marcado pela reconciliação). Quem lê a tabela como "estado atual" (export, OData) precisa
 * escondê-las (filtro PERMANENTE: no MSSQL é a única barreira; no Postgres soma-se à RLS cw_hide_deleted); só a API `rows?since=` as entrega, via `removedKeys`.
 *
 * Devolve o predicado `<cw_deleted_at> IS NULL` já citado para o provider, ou null quando a
 * tabela não tem a coluna (dados anteriores à feature). O resultado é cacheado por poucos
 * segundos: a coluna só muda quando a tabela é recriada.
 */
const TTL_MS = 60_000;
const cache = new WeakMap<StorageConnection, Map<string, { at: number; hasCol: boolean }>>();

export async function hasDeletedAtColumn(conn: StorageConnection, schema: string, table: string): Promise<boolean> {
  let perConn = cache.get(conn);
  if (!perConn) { perConn = new Map(); cache.set(conn, perConn); }
  const key = `${schema}.${table}`;
  const hit = perConn.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.hasCol;
  const cols = await conn.listColumns(schema, table);
  const hasCol = cols.some((c) => c.name === CW_DELETED_AT);
  perConn.set(key, { at: Date.now(), hasCol });
  return hasCol;
}

export async function activeRowsPredicate(conn: StorageConnection, schema: string, table: string): Promise<string | null> {
  return (await hasDeletedAtColumn(conn, schema, table)) ? `${conn.q(CW_DELETED_AT)} IS NULL` : null;
}

/** Junta condições WHERE (já parentesadas) ignorando as vazias; devolve "" ou " WHERE ...". */
export function joinWhere(...parts: (string | null | undefined)[]): string {
  const p = parts.filter((x): x is string => !!x && x.trim() !== "").map((x) => `(${x})`);
  return p.length ? ` WHERE ${p.join(" AND ")}` : "";
}
