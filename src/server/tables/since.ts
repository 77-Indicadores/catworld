/**
 * `GET /tables/:id/rows?since=…` (Postgres) — protocolo de mudancas SEM PERDA e SEM REPETICAO INFINITA.
 *
 * Semantica (documentada tambem em docs/since-protocol.md):
 *  1. RELOGIO DO STORAGE. `cw_synced_at` e um `timestamp` sem fuso, carimbado por `now()` do servidor de storage. O
 *     protocolo trata esse valor como UTC e o rotula `Z`; nenhuma conversao usa o fuso do processo Node (nunca
 *     `new Date("YYYY-MM-DD HH:MM:SS")`, que e hora local). Se o servidor de storage nao roda em UTC, o rotulo `Z` e
 *     "o relogio do storage" — o valor continua consistente entre chamadas, que e o que o cursor exige.
 *  2. PRECISAO. O Postgres guarda microssegundos; JS Date so tem milissegundos. `since`/`nextSince` sao montados
 *     do TEXTO (`cw_synced_at::text`), com 6 casas: `2026-09-19T10:00:00.123456Z`. Antes o `>` comparava contra o valor
 *     truncado em ms e a mesma linha era devolvida para sempre.
 *  3. JANELA DE SEGURANCA. `now()` e o inicio da transacao do escritor: uma transacao longa pode COMMITAR depois de
 *     outra, mais nova, ja ter sido lida (o carimbo mais antigo aparece "atras" do cursor e a linha se perde).
 *     Logo `nextSince = min(maior carimbo lido, agora_do_storage - JANELA)`, nunca abaixo do `since` recebido. Linhas
 *     dentro da janela podem voltar em chamadas seguintes; o cliente deduplica (`meta.rowStamps` + impressao digital
 *     da linha — ver SDK). Fora da janela nao ha repeticao: `nextSince` estabiliza no maior carimbo.
 *  4. BASELINE. Sem `since`, a rota pagina igual (a partir do inicio dos tempos): `hasMore` + `nextCursor`.
 *
 * Paginacao (herdada): um sync grava o lote inteiro com o MESMO `cw_synced_at`. Paginar por "ultimo timestamp visto"
 * com `>` estrito perdia tudo que passava do `limit`. Logo:
 *  - SEM cursor: a pagina nunca corta um grupo empatado no meio — inclui o grupo INTEIRO (ate TIE_CAP linhas).
 *  - COM cursor: ordem (cw_synced_at, chave), paginas estritas de `limit` linhas, `meta.hasMore` + `meta.nextCursor`.
 */

export const TIE_CAP = 50_000;

/** Janela de seguranca padrao (ms): cobre transacoes de carga de ate 5 min. Ajustavel por CW_SINCE_SAFETY_WINDOW_SEC. */
export const DEFAULT_SAFETY_WINDOW_MS = 300_000;

export function safetyWindowMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.CW_SINCE_SAFETY_WINDOW_SEC;
  if (raw === undefined || raw.trim() === "") return DEFAULT_SAFETY_WINDOW_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 86_400 ? Math.round(n * 1000) : DEFAULT_SAFETY_WINDOW_MS;
}

/** "Inicio dos tempos" para o baseline (sem `since`). */
export const BASELINE_SINCE_TXT = "0001-01-01 00:00:00.000000";

/** SQL do relogio do storage no mesmo formato/fuso dos carimbos. */
export const PG_NOW_TXT_SQL = "SELECT now()::timestamp::text AS n";

export type Cursor = { t: string; k: string | number };

const TS_TEXT = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?$/;
const ISO_ANY = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

// ---------------------------------------------------------------------------
// Instantes como texto "YYYY-MM-DD HH:MM:SS.ffffff" (relogio do storage) — sem Date local.
// ---------------------------------------------------------------------------

const pad = (n: number, w: number) => String(n).padStart(w, "0");

/** Normaliza um texto de timestamp para "YYYY-MM-DD HH:MM:SS.ffffff" (comparavel como string). null se invalido. */
export function normTs(txt: string): string | null {
  const m = ISO_ANY.exec(txt.trim());
  if (!m || (m[8] && m[8].toUpperCase() !== "Z")) return null; // naive ou rotulado Z (= relogio do storage); offset nao
  const [, y, mo, d, h = "00", mi = "00", s = "00", frac = ""] = m;
  return `${y}-${mo}-${d} ${h}:${mi}:${s}.${(frac + "000000").slice(0, 6)}`;
}

/** Microssegundos desde a epoca (UTC) de um texto normalizado. */
export function toMicros(norm: string): bigint {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{6})$/.exec(norm)!;
  // setUTC* (e nao Date.UTC): Date.UTC trata anos 0-99 como 1900+
  const d = new Date(0);
  d.setUTCFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setUTCHours(Number(m[4]), Number(m[5]), Number(m[6]), 0);
  return BigInt(d.getTime()) * 1000n + BigInt(m[7]!);
}

export function fromMicros(us: bigint): string {
  const ms = Number(us / 1000n);
  let rem = Number(us % 1000n);
  let msAdj = ms;
  if (rem < 0) { rem += 1000; msAdj -= 1; }
  const d = new Date(msAdj);
  const micro = pad(d.getUTCMilliseconds(), 3) + pad(rem, 3);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)} ${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}.${micro}`;
}

/** "2026-09-19 10:00:00.123456" -> "2026-09-19T10:00:00.123456Z" */
export const isoFromTs = (norm: string) => `${norm.replace(" ", "T")}Z`;

export type ParsedSince = { /** texto normalizado do relogio do storage */ txt: string; /** literal SQL seguro */ sqlLiteral: string; iso: string };

/**
 * Interpreta `?since=`. Sem fuso (ou com `Z`) = UTC. Com offset (+03:00) converte para UTC. Mantem microssegundos.
 * Nunca usa o fuso do processo. null se invalido.
 */
export function parseSince(raw: string): ParsedSince | null {
  const m = ISO_ANY.exec(raw.trim());
  if (!m) return null;
  const [, y, mo, d, h = "00", mi = "00", s = "00", frac = "", tz] = m;
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31 || Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return null;
  let norm = `${y}-${mo}-${d} ${h}:${mi}:${s}.${(frac + "000000").slice(0, 6)}`;
  const probe = new Date(`${y}-${mo}-${d}T00:00:00Z`);
  if (isNaN(probe.getTime()) || probe.getUTCDate() !== Number(d)) return null; // 31 de fevereiro etc.
  if (tz && tz.toUpperCase() !== "Z") {
    const sign = tz[0] === "-" ? -1n : 1n;
    const digits = tz.slice(1).replace(":", "");
    const oh = Number(digits.slice(0, 2));
    const om = Number(digits.slice(2, 4) || "0");
    norm = fromMicros(toMicros(norm) - sign * BigInt((oh * 60 + om) * 60) * 1_000_000n);
  }
  // ano 0000 (ou fora de 0001-9999 apos o offset) nao existe no Postgres: 400 em vez de 500
  if (norm.length !== 26 || Number(norm.slice(0, 4)) < 1) return null;
  return { txt: norm, sqlLiteral: `'${norm}'`, iso: isoFromTs(norm) };
}

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
  /** literal SQL do `since` (use `parseSince(raw).sqlLiteral`; para baseline, `'${BASELINE_SINCE_TXT}'`) */
  sinceLit: string;
  cursor: Cursor | null;
  limit: number;
};

/** Pagina de linhas alteradas: limit+1 (para saber hasMore), ordenada por (cw_synced_at, chave). */
export function pgRowsPageSql(i: SincePageInput): string {
  const keySel = i.qKey ? `, ${i.qKey} AS __cw_key` : "";
  let cond = `${i.qSynced} > ${i.sinceLit}::timestamp`;
  if (i.cursor) {
    if (!i.qKey) throw new Error("cursor exige tabela com chave");
    const t = `'${i.cursor.t}'::timestamp`;
    cond = `(${i.qSynced} > ${t} OR (${i.qSynced} = ${t} AND ${i.qKey} > ${keyLiteral(i.cursor.k, i.keySqlType)}))`;
  }
  const order = i.qKey ? `${i.qSynced} ASC, ${i.qKey} ASC` : `${i.qSynced} ASC`;
  return `SELECT ${i.colList}, ${i.qSynced}::text AS __cw_synced_txt${keySel} FROM ${i.qTarget} WHERE ${i.qDeleted} IS NULL AND ${cond} ORDER BY ${order} LIMIT ${i.limit + 1}`;
}

export const REMOVED_CAP = 100_000;

/**
 * Exclusoes desde `since`; `d` vem como TEXTO ISO com `Z` e 6 casas (`2026-09-19T10:00:00.123456Z`, o relogio do storage
 * rotulado UTC, como `nextSince`). Assim `new Date(String(d))` (chamadores antigos) e o instante correto em qualquer fuso do
 * Node (antes o texto sem fuso virava hora LOCAL) e `normTs(d)` continua devolvendo o texto normalizado (aceita `Z`).
 * Perde nada: o `Date` so tem ms; quem precisa dos microssegundos usa `normTs`.
 */
export function pgRemovedSql(i: Pick<SincePageInput, "qTarget" | "qDeleted" | "qKey" | "sinceLit">): string {
  return `SELECT ${i.qKey} AS k, to_char(${i.qDeleted}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS d FROM ${i.qTarget} WHERE ${i.qDeleted} > ${i.sinceLit}::timestamp ORDER BY ${i.qDeleted} ASC, ${i.qKey} ASC LIMIT ${REMOVED_CAP + 1}`;
}

export type PageRow = Record<string, unknown> & { __cw_synced_txt: unknown; __cw_synced_at?: unknown; __cw_key?: unknown };

/** Carimbo de uma linha como texto normalizado. Aceita Date (compat.) so via ISO UTC. */
function stampTxt(r: PageRow): string {
  const t = r.__cw_synced_txt;
  if (t != null) {
    const n = normTs(String(t));
    if (n) return n;
  }
  const a = r.__cw_synced_at;
  if (a instanceof Date) return fromMicros(BigInt(a.getTime()) * 1000n);
  const n = normTs(String(a ?? ""));
  if (n) return n;
  throw new Error("linha sem carimbo cw_synced_at");
}

const maxTxt = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a >= b ? a : b);
const maxStamp = (rows: PageRow[]): string | null => rows.reduce<string | null>((m, r) => maxTxt(m, stampTxt(r)), null);
const cursorOf = (last: PageRow): string | null =>
  last.__cw_key !== undefined && last.__cw_key !== null
    ? encodeCursor({ t: String(last.__cw_synced_txt), k: typeof last.__cw_key === "number" ? last.__cw_key : String(last.__cw_key) })
    : null;

/** `since` aceito: texto normalizado, ISO com Z ou Date (so ms; legado). */
export type SinceInput = string | Date;
const sinceTxtOf = (s: SinceInput): string =>
  s instanceof Date ? fromMicros(BigInt(s.getTime()) * 1000n) : (normTs(s) ?? parseSince(s)?.txt ?? BASELINE_SINCE_TXT);

export type Settled = {
  page: PageRow[];
  hasMore: boolean;
  nextCursor: string | null;
  /** Proximo `since` (texto normalizado, microssegundos) ANTES da janela de seguranca. Use `finalizeNextSince`. */
  nextSinceTxt: string;
  /** @deprecated so ms e fuso-independente apenas se lido com `.toISOString()`; prefira `nextSinceTxt`. */
  nextSince: Date;
  tieGroupTruncated?: boolean;
};

const mk = (page: PageRow[], hasMore: boolean, nextCursor: string | null, nextTxt: string, extra: { tieGroupTruncated?: boolean } = {}): Settled => ({
  page, hasMore, nextCursor, nextSinceTxt: nextTxt, nextSince: new Date(isoFromTs(nextTxt).replace(/(\.\d{3})\d{3}Z$/, "$1Z")), ...extra,
});

/**
 * 1a pagina (sem cursor). `first` veio com limit+1 linhas; `fetchBig` busca ate TIE_CAP+1 quando o corte cairia no meio
 * de um grupo empatado. Garante: nextSince nunca pula linha e sempre avanca (exceto grupo maior que TIE_CAP — ai
 * mantem o comportamento antigo de avancar, mas sinaliza `tieGroupTruncated` + `hasMore` + cursor para quem quiser recuperar).
 */
export async function settleFirstPage(first: PageRow[], limit: number, since: SinceInput, fetchBig: () => Promise<PageRow[]>): Promise<Settled> {
  const sinceTxt = sinceTxtOf(since);
  if (first.length <= limit) {
    return mk(first, false, null, maxStamp(first) ?? sinceTxt);
  }
  const txt = (r: PageRow) => stampTxt(r);
  const boundaryTie = limit > 0 && txt(first[limit]!) === txt(first[limit - 1]!);
  if (!boundaryTie) {
    const page = first.slice(0, limit);
    return mk(page, true, page.length ? cursorOf(page[page.length - 1]!) : null, maxStamp(page) ?? sinceTxt);
  }
  const lastTxt = txt(first[limit - 1]!);
  const big = await fetchBig();
  const end = big.findIndex((r) => txt(r) !== lastTxt);
  if (end === -1) {
    if (big.length <= TIE_CAP) return mk(big, false, null, maxStamp(big) ?? sinceTxt);
    const page = first.slice(0, limit);
    return mk(page, true, cursorOf(page[page.length - 1]!), maxStamp(page) ?? sinceTxt, { tieGroupTruncated: true });
  }
  const page = big.slice(0, end);
  return mk(page, true, cursorOf(page[page.length - 1]!), maxStamp(page) ?? sinceTxt);
}

/**
 * Paginas COM cursor (estritas, `limit` linhas). `nextSince` e conservador enquanto ha mais paginas: maior timestamp
 * ESTRITAMENTE anterior ao do ultimo grupo empatado (ou `since`); na ultima pagina e o maior timestamp devolvido.
 */
export function shapeRowsPage(rows: PageRow[], limit: number, since: SinceInput): Settled {
  const sinceTxt = sinceTxtOf(since);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  if (!hasMore) return mk(page, false, null, maxStamp(page) ?? sinceTxt);
  const last = page[page.length - 1]!;
  const lastTxt = stampTxt(last);
  let boundary: string | null = null;
  for (const r of page) {
    const t = stampTxt(r);
    if (t === lastTxt) continue;
    boundary = maxTxt(boundary, t);
  }
  return mk(page, true, cursorOf(last), boundary ?? sinceTxt);
}

/**
 * `nextSince` FINAL entregue ao cliente (ISO com Z e 6 casas), aplicando a janela de seguranca.
 *  - ainda ha paginas (ou exclusoes truncadas): o valor conservador da pagina, sem janela (o cursor ja garante a continuidade);
 *  - ultima pagina: min(maior carimbo lido/excluido, agora_do_storage - janela), nunca abaixo do `since` recebido.
 */
export function finalizeNextSince(o: {
  settled: Pick<Settled, "hasMore" | "nextSinceTxt">;
  since: SinceInput;
  /** maior `cw_deleted_at` entre as exclusoes entregues (texto), se houver */
  removedMaxTxt?: string | null;
  removedTruncated?: boolean;
  /** relogio do storage (PG_NOW_TXT_SQL) */
  nowTxt: string;
  windowMs: number;
}): string {
  const sinceTxt = sinceTxtOf(o.since);
  if (o.settled.hasMore || o.removedTruncated) return isoFromTs(maxTxt(o.settled.nextSinceTxt, sinceTxt)!);
  const seen = maxTxt(o.settled.nextSinceTxt, o.removedMaxTxt ? normTs(o.removedMaxTxt) : null)!;
  const now = normTs(o.nowTxt);
  let next = seen;
  if (now) {
    const cap = fromMicros(toMicros(now) - BigInt(o.windowMs) * 1000n);
    if (cap < next) next = cap;
  }
  if (next < sinceTxt) next = sinceTxt; // nunca regride
  return isoFromTs(next);
}

/** Carimbos (texto, 6 casas, com Z) das linhas da pagina, na mesma ordem — `meta.rowStamps` para dedupe no cliente. */
export const rowStampsOf = (page: PageRow[]): string[] => page.map((r) => isoFromTs(stampTxt(r)));
