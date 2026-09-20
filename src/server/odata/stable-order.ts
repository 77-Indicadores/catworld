/**
 * ORDER BY deterministico para paginacao/extracao por OFFSET.
 *
 * Sem ORDER BY, LIMIT/OFFSET (e OFFSET/FETCH) nao garantem ordem entre paginas: linhas se repetem ou somem.
 * Sem chave conhecida, ordena-se por todas as colunas comparaveis (linhas identicas sao indistinguiveis, entao
 * repeti-las na ordem que for nao muda o resultado). No Postgres, `ctid` (posicao fisica) e barato e unico.
 */
export type OrderCol = { name: string; sqlType?: string | null };

// Tipos sem operador de ordenacao (SQL Server: text/ntext/image/xml/...; Postgres: json/xml/geometricos).
const UNORDERABLE = /^(TEXT|NTEXT|IMAGE|XML|GEOGRAPHY|GEOMETRY|SQL_VARIANT|HIERARCHYID|JSON|POINT|LINE|LSEG|BOX|PATH|POLYGON|CIRCLE)$/i;

export function orderableColumns<T extends OrderCol>(cols: T[]): T[] {
  return cols.filter((c) => !UNORDERABLE.test((c.sqlType ?? "").replace(/\(.*\)/, "").trim()));
}

/** Lista de ORDER BY (sem a palavra ORDER BY) ou `null` quando nada permite ordem estavel. */
export function stableOrderBy(
  cols: OrderCol[],
  quote: (name: string) => string,
  o: { useCtid?: boolean } = {},
): string | null {
  if (o.useCtid) return "ctid";
  const usable = orderableColumns(cols);
  return usable.length ? usable.map((c) => quote(c.name)).join(", ") : null;
}

export const UNSTABLE_ORDER_WARNING = "sem $orderby e sem colunas ordenaveis: a ordem entre paginas nao e garantida (linhas podem se repetir ou faltar)";
