/**
 * `GET /tables/:id/rows?since=…` (Postgres) — paginacao SEM PERDA.
 *
 * O problema: um sync grava o lote inteiro com o MESMO `cw_synced_at`. Paginar por "ultimo timestamp visto" com `>`
 * estrito perdia tudo que passava do `limit` (reproduzido: cliente recebeu 1000 de 2500 linhas; a 2a chamada voltou
 * vazia). Agora:
 *  - SEM cursor (quem segue so `nextSince`, como sempre): a pagina nunca corta um grupo empatado no meio — inclui o grupo
 *    INTEIRO (ate TIE_CAP linhas, podendo passar do `limit`). Assim `nextSince` sempre avanca e nada se perde.
 *  - COM cursor (aditivo): ordem (cw_synced_at, chave), paginas estritas de `limit` linhas, `meta.hasMore` +
 *    `meta.nextCursor`, aceito de volta em `?cursor=`. Serve para lotes maiores que TIE_CAP.
 */

export const TIE_CAP = 50_000;

export type Cursor = { t: string; k: string | number };

const TS_TEXT = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?$/;

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

/** null se o cursor for invalido (o chamador responde 400). */
export function decodeCursor(raw: string): Cursor | null {
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<Cursor>;
    if (typeof c.t !== "string" || !TS_TEXT.test(c.t)) return null;
    if (typeof c.k !== "string" && typeof c.k !== "number") return null;
    if (typeof c.k === "number" && !Number.isFinite(c.k)) return null;
    return { t: c.t.replace("T", " "), k: c.k };
  } catch {
    return null;
  }
}

const NUMERIC = new Set(["BIGINT", "INT", "INTEGER", "SMALLINT", "TINYINT", "DECIMAL", "NUMERIC", "FLOAT", "REAL", "MONEY"]);

export const isNumericType = (sqlType: string) => NUMERIC.has(sqlType.toUpperCase().replace(/\(.*\)/, "").trim());

/** Literal SQL seguro para a chave (numero validado ou string escapada). */
export function keyLiteral(k: string | number, sqlType: string): string {
  if (isNumericType(sqlType)) {
    const n = typeof k === "number" ? String(k) : k.trim();
    if (!/^-?\d+(\.\d+)?$/.test(n)) throw new Error("chave do cursor invalida");
    return n;
  }
  return `'${String(k).replace(/'/g, "''")}'`;
}

export type SincePageInput = {
  qTarget: string;
  colList: string;
  qSynced: string;
  qDeleted: string;
  /** coluna-chave ja com aspas; null = sem upsert (sem como desempatar) */
  qKey: string | null;
  keySqlType: string;
  sinceLit: string;
  cursor: Cursor | null;
  limit: number;
};

/** Pagina de linhas alteradas: limit+1 (para saber hasMore), ordenada por (cw_synced_at, chave). */
export function pgRowsPageSql(i: SincePageInput): string {
  const keySel = i.qKey ? `, ${i.qKey} AS __cw_key` : "";
  let cond = `${i.qSynced} > ${i.sinceLit}`;
  if (i.cursor) {
    if (!i.qKey) throw new Error("cursor exige tabela com chave");
    const t = `'${i.cursor.t}'::timestamp`;
    cond = `(${i.qSynced} > ${t} OR (${i.qSynced} = ${t} AND ${i.qKey} > ${keyLiteral(i.cursor.k, i.keySqlType)}))`;
  }
  const order = i.qKey ? `${i.qSynced} ASC, ${i.qKey} ASC` : `${i.qSynced} ASC`;
  return `SELECT ${i.colList}, ${i.qSynced} AS __cw_synced_at, ${i.qSynced}::text AS __cw_synced_txt${keySel} FROM ${i.qTarget} WHERE ${i.qDeleted} IS NULL AND ${cond} ORDER BY ${order} LIMIT ${i.limit + 1}`;
}

export const REMOVED_CAP = 100_000;

export function pgRemovedSql(i: Pick<SincePageInput, "qTarget" | "qDeleted" | "qKey" | "sinceLit">): string {
  return `SELECT ${i.qKey} AS k, ${i.qDeleted} AS d FROM ${i.qTarget} WHERE ${i.qDeleted} > ${i.sinceLit} ORDER BY ${i.qDeleted} ASC, ${i.qKey} ASC LIMIT ${REMOVED_CAP + 1}`;
}

export type PageRow = Record<string, unknown> & { __cw_synced_at: unknown; __cw_synced_txt: unknown; __cw_key?: unknown };

const toDate = (v: unknown) => (v instanceof Date ? v : new Date(String(v)));
const maxTs = (rows: PageRow[]): Date | null => {
  let m: Date | null = null;
  for (const r of rows) { const d = toDate(r.__cw_synced_at); if (!m || d > m) m = d; }
  return m;
};
const cursorOf = (last: PageRow): string | null =>
  last.__cw_key !== undefined && last.__cw_key !== null
    ? encodeCursor({ t: String(last.__cw_synced_txt), k: typeof last.__cw_key === "number" ? last.__cw_key : String(last.__cw_key) })
    : null;

export type Settled = { page: PageRow[]; hasMore: boolean; nextCursor: string | null; nextSince: Date; tieGroupTruncated?: boolean };

/**
 * 1a pagina (sem cursor). `first` veio com limit+1 linhas; `fetchBig` busca ate TIE_CAP+1 quando o corte cairia no meio
 * de um grupo empatado. Garante: nextSince nunca pula linha e sempre avanca (exceto grupo maior que TIE_CAP — ai
 * mantem o comportamento antigo de avancar, mas sinaliza `tieGroupTruncated` + `hasMore` + cursor para quem quiser recuperar).
 */
export async function settleFirstPage(first: PageRow[], limit: number, since: Date, fetchBig: () => Promise<PageRow[]>): Promise<Settled> {
  if (first.length <= limit) {
    return { page: first, hasMore: false, nextCursor: null, nextSince: maxTs(first) ?? since };
  }
  const txt = (r: PageRow) => String(r.__cw_synced_txt);
  const boundaryTie = limit > 0 && txt(first[limit]!) === txt(first[limit - 1]!);
  if (!boundaryTie) {
    const page = first.slice(0, limit);
    return { page, hasMore: true, nextCursor: page.length ? cursorOf(page[page.length - 1]!) : null, nextSince: maxTs(page) ?? since };
  }
  const lastTxt = txt(first[limit - 1]!);
  const big = await fetchBig();
  const end = big.findIndex((r) => txt(r) !== lastTxt);
  if (end === -1) {
    if (big.length <= TIE_CAP) return { page: big, hasMore: false, nextCursor: null, nextSince: maxTs(big) ?? since };
    const page = first.slice(0, limit);
    return { page, hasMore: true, nextCursor: cursorOf(page[page.length - 1]!), nextSince: maxTs(page) ?? since, tieGroupTruncated: true };
  }
  const page = big.slice(0, end);
  return { page, hasMore: true, nextCursor: cursorOf(page[page.length - 1]!), nextSince: maxTs(page) ?? since };
}

/**
 * Paginas COM cursor (estritas, `limit` linhas). `nextSince` e conservador enquanto ha mais paginas: maior timestamp
 * ESTRITAMENTE anterior ao do ultimo grupo empatado (ou `since`); na ultima pagina e o maior timestamp devolvido.
 */
export function shapeRowsPage(rows: PageRow[], limit: number, since: Date): Settled {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  if (!hasMore) return { page, hasMore: false, nextCursor: null, nextSince: maxTs(page) ?? since };
  const last = page[page.length - 1]!;
  const lastTxt = String(last.__cw_synced_txt);
  let boundary: Date | null = null;
  for (const r of page) {
    if (String(r.__cw_synced_txt) === lastTxt) continue;
    const d = toDate(r.__cw_synced_at);
    if (!boundary || d > boundary) boundary = d;
  }
  return { page, hasMore: true, nextCursor: cursorOf(last), nextSince: boundary ?? since };
}
