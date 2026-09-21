/**
 * `$filter` e `$orderby` do OData v4 (subconjunto) -> SQL Postgres.
 *
 * Antes o servidor IGNORAVA essas opcoes em silencio: `$filter=Id eq 1` devolvia a tabela inteira e o Power BI
 * (que "dobra" filtros para o servidor) mostrava dado errado. O subconjunto suportado e APLICADO; o que nao for
 * entendido (ou o backend nao suportar) e um ERRO claro — 400 (expressao invalida) ou 501 (opcao nao implementada) —
 * porque devolver a tabela inteira quando o cliente pediu um filtro entrega dado errado como se estivesse certo (ENT-07).
 *
 * Nulos (OData v4 5.1.1): `eq`/`gt`/... com um operando nulo e falso; `ne` com nulo e verdadeiro; `not` inverte o
 * booleano (nao propaga NULL do SQL). Ou seja `valor ne 20` e `not (valor eq 20)` INCLUEM as linhas com valor nulo.
 *
 * Suportado: eq ne gt ge lt le, and or not, parenteses, null, true/false, strings 'x', numeros, datas
 * (2024-01-31) e datetimes (2024-01-31T10:00:00Z), contains/startswith/endswith(col,'x'), year/month/day(col).
 * Colunas so pelo nome do catalogo. Valores sao validados e ESCAPADOS (nada do cliente vai cru para o SQL).
 */

export type ODataColumn = { sqlName: string; sqlType: string };

export class UnsupportedODataOption extends Error {}

type Cat = "string" | "number" | "bool" | "date" | "datetime" | "time" | "guid";

const catOf = (sqlType: string): Cat => {
  const t = sqlType.toUpperCase().replace(/\(.*\)/, "").trim();
  if (["BIGINT", "INT", "INTEGER", "SMALLINT", "TINYINT", "DECIMAL", "NUMERIC", "MONEY", "SMALLMONEY", "FLOAT", "REAL"].includes(t)) return "number";
  if (t === "BIT") return "bool";
  if (t === "DATE") return "date";
  if (["DATETIME", "DATETIME2", "SMALLDATETIME", "DATETIMEOFFSET"].includes(t)) return "datetime";
  if (t === "TIME") return "time";
  if (t === "UNIQUEIDENTIFIER") return "guid";
  return "string";
};

// ------------------------------------------------------------------ tokenizer
type Tok = { t: "(" | ")" | "," | "str" | "num" | "date" | "dt" | "id" | "eof"; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === "(" || c === ")" || c === ",") { out.push({ t: c, v: c }); i++; continue; }
    if (c === "'") {
      let j = i + 1;
      let s = "";
      while (j < src.length) {
        if (src[j] === "'" && src[j + 1] === "'") { s += "'"; j += 2; continue; }
        if (src[j] === "'") break;
        s += src[j++];
      }
      if (j >= src.length) throw new UnsupportedODataOption("string sem fechamento");
      out.push({ t: "str", v: s });
      i = j + 1;
      continue;
    }
    const dt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?/.exec(src.slice(i));
    if (dt) { out.push({ t: "dt", v: dt[0] }); i += dt[0].length; continue; }
    const d = /^\d{4}-\d{2}-\d{2}(?![\dT])/.exec(src.slice(i));
    if (d) { out.push({ t: "date", v: d[0] }); i += d[0].length; continue; }
    const n = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(src.slice(i));
    if (n) { out.push({ t: "num", v: n[0] }); i += n[0].length; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) { out.push({ t: "id", v: id[0] }); i += id[0].length; continue; }
    throw new UnsupportedODataOption(`caractere '${c}' nao suportado`);
  }
  out.push({ t: "eof", v: "" });
  return out;
}

// ------------------------------------------------------------------ parser -> AST
type Lit = { k: "lit"; cat: Cat | "null"; sql: string; raw: string };
type Col = { k: "col"; col: ODataColumn; cat: Cat };
type Fn = { k: "fn"; sql: string; cat: Cat | "bool" };
type Expr = Lit | Col | Fn | { k: "bool"; sql: string };

const sqlStr = (s: string) => `'${s.replace(/'/g, "''")}'`;

function isoToSqlTs(iso: string): string {
  const d = new Date(/(Z|[+-]\d{2}:\d{2})$/.test(iso) ? iso : `${iso}Z`);
  if (isNaN(d.getTime())) throw new UnsupportedODataOption(`data/hora invalida: ${iso}`);
  return d.toISOString().replace("T", " ").replace("Z", "");
}

export function translateFilter(src: string, columns: ODataColumn[], ref: (c: ODataColumn) => string): string {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p]!;
  const next = () => toks[p++]!;
  const kw = (w: string) => peek().t === "id" && peek().v.toLowerCase() === w;
  const colByName = new Map(columns.map((c) => [c.sqlName, c]));

  function parseOr(): string {
    let l = parseAnd();
    while (kw("or")) { next(); l = `(${l} OR ${parseAnd()})`; }
    return l;
  }
  function parseAnd(): string {
    let l = parseNot();
    while (kw("and")) { next(); l = `(${l} AND ${parseNot()})`; }
    return l;
  }
  function parseNot(): string {
    // COALESCE: em SQL, NOT(NULL) e NULL (linha some); em OData, comparacao com nulo e FALSE e `not` dela e TRUE
    if (kw("not")) { next(); return `(NOT COALESCE(${parseNot()}, FALSE))`; }
    return parseCmp();
  }
  function parseCmp(): string {
    const l = parsePrimary();
    const opTok = peek();
    const ops: Record<string, string> = { eq: "=", ne: "<>", gt: ">", ge: ">=", lt: "<", le: "<=" };
    if (opTok.t === "id" && ops[opTok.v.toLowerCase()]) {
      next();
      const r = parsePrimary();
      return compare(l, ops[opTok.v.toLowerCase()]!, r);
    }
    if (l.k === "bool") return l.sql;
    if (l.k === "fn" && l.cat === "bool") return l.sql;
    if (l.k === "col" && l.cat === "bool") return ref(l.col);
    throw new UnsupportedODataOption("expressao sem comparacao");
  }

  function compare(l: Expr, op: string, r: Expr): string {
    const left = l.k === "col" ? ref(l.col) : l.sql;
    const right = r.k === "col" ? ref(r.col) : r.sql;
    const lc = l.k === "lit" ? l.cat : l.k === "bool" ? "bool" : l.cat;
    const rc = r.k === "lit" ? r.cat : r.k === "bool" ? "bool" : r.cat;
    if (rc === "null" || lc === "null") {
      if (op !== "=" && op !== "<>") throw new UnsupportedODataOption("null so com eq/ne");
      const other = rc === "null" ? left : right;
      return `(${other} IS ${op === "=" ? "" : "NOT "}NULL)`;
    }
    const same = lc === rc
      || (lc === "datetime" && rc === "date") || (lc === "date" && rc === "datetime")
      || (lc === "guid" && rc === "string") || (lc === "string" && rc === "guid");
    if (!same) throw new UnsupportedODataOption(`tipos incompativeis (${lc} x ${rc})`);
    if (lc === "bool" && op !== "=" && op !== "<>") throw new UnsupportedODataOption("booleano so com eq/ne");
    // datetime x date: compara como timestamp
    const wrap = (e: Expr, s: string) => (e.k === "lit" && e.cat === "date" && (lc === "datetime" || rc === "datetime")) ? `CAST(${s} AS TIMESTAMP)` : s;
    if (op === "<>") {
      // `ne`: nulo ne valor e VERDADEIRO. Coluna x literal nao nulo: `<> OR IS NULL`; demais casos: IS DISTINCT FROM.
      const nullable = (e: Expr) => e.k === "col" || e.k === "fn";
      if (nullable(l) && r.k === "lit") return `((${wrap(l, left)} <> ${wrap(r, right)}) OR (${left} IS NULL))`;
      if (nullable(r) && l.k === "lit") return `((${wrap(l, left)} <> ${wrap(r, right)}) OR (${right} IS NULL))`;
      return `(${wrap(l, left)} IS DISTINCT FROM ${wrap(r, right)})`;
    }
    return `(${wrap(l, left)} ${op} ${wrap(r, right)})`;
  }

  function likeArg(e: Expr): string {
    if (e.k !== "lit" || e.cat !== "string") throw new UnsupportedODataOption("contains/startswith/endswith exigem texto literal");
    return e.raw.replace(/[\\%_]/g, (m) => `\\${m}`);
  }

  function parsePrimary(): Expr {
    const t = next();
    if (t.t === "(") {
      const inner = parseOr();
      if (next().t !== ")") throw new UnsupportedODataOption("parentese nao fechado");
      return { k: "bool", sql: inner };
    }
    if (t.t === "str") return { k: "lit", cat: "string", sql: sqlStr(t.v), raw: t.v };
    if (t.t === "num") return { k: "lit", cat: "number", sql: String(Number(t.v)) === "NaN" ? "0" : t.v, raw: t.v };
    if (t.t === "date") return { k: "lit", cat: "date", sql: `DATE '${t.v}'`, raw: t.v };
    if (t.t === "dt") return { k: "lit", cat: "datetime", sql: `TIMESTAMP '${isoToSqlTs(t.v)}'`, raw: t.v };
    if (t.t === "id") {
      const name = t.v;
      const lower = name.toLowerCase();
      if (peek().t === "(") {
        next();
        const args: Expr[] = [];
        if (peek().t !== ")") {
          args.push(parsePrimary());
          while (peek().t === ",") { next(); args.push(parsePrimary()); }
        }
        if (next().t !== ")") throw new UnsupportedODataOption("parentese nao fechado");
        if (["contains", "startswith", "endswith"].includes(lower)) {
          if (args.length !== 2 || args[0]!.k !== "col" || (args[0] as Col).cat !== "string") throw new UnsupportedODataOption(`${lower} exige (coluna de texto, 'texto')`);
          const arg = likeArg(args[1]!);
          const pat = lower === "contains" ? `%${arg}%` : lower === "startswith" ? `${arg}%` : `%${arg}`;
          return { k: "fn", cat: "bool", sql: `(${ref((args[0] as Col).col)} LIKE ${sqlStr(pat)} ESCAPE '\\')` };
        }
        if (["year", "month", "day"].includes(lower)) {
          if (args.length !== 1 || args[0]!.k !== "col" || !["date", "datetime"].includes((args[0] as Col).cat)) throw new UnsupportedODataOption(`${lower} exige coluna de data`);
          return { k: "fn", cat: "number", sql: `EXTRACT(${lower.toUpperCase()} FROM ${ref((args[0] as Col).col)})` };
        }
        throw new UnsupportedODataOption(`funcao '${name}' nao suportada`);
      }
      if (lower === "true" || lower === "false") return { k: "lit", cat: "bool", sql: lower.toUpperCase(), raw: lower };
      if (lower === "null") return { k: "lit", cat: "null", sql: "NULL", raw: "null" };
      const col = colByName.get(name);
      if (!col) throw new UnsupportedODataOption(`coluna '${name}' inexistente`);
      return { k: "col", col, cat: catOf(col.sqlType) };
    }
    throw new UnsupportedODataOption("expressao invalida");
  }

  const sql = parseOr();
  if (peek().t !== "eof") throw new UnsupportedODataOption("texto sobrando apos a expressao");
  return sql;
}

/** `col [asc|desc], col2 …` -> ORDER BY com NULL como menor valor (OData v4: ASC = NULL primeiro). */
export function translateOrderBy(src: string, columns: ODataColumn[], ref: (c: ODataColumn) => string): string {
  const byName = new Map(columns.map((c) => [c.sqlName, c]));
  const parts = src.split(",").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new UnsupportedODataOption("$orderby vazio");
  return parts.map((part) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\s+(asc|desc))?$/i.exec(part);
    if (!m) throw new UnsupportedODataOption(`ordenacao '${part}' nao suportada`);
    const col = byName.get(m[1]!);
    if (!col) throw new UnsupportedODataOption(`coluna '${m[1]}' inexistente`);
    const desc = (m[2] ?? "asc").toLowerCase() === "desc";
    return `${ref(col)} ${desc ? "DESC NULLS LAST" : "ASC NULLS FIRST"}`;
  }).join(", ");
}

export type ODataQueryPlan = { where: string | null; orderBy: string | null; warnings: string[] };

/** Erro de consulta OData para o cliente: 400 = expressao invalida; 501 = opcao/backend nao suportado. */
export class ODataOptionError extends Error {
  constructor(readonly status: 400 | 501, readonly code: string, message: string) { super(message); }
}

/** Opcoes que mudariam o RESULTADO se ignoradas: erro 501 em vez de devolver dado errado. */
const UNSUPPORTED_OPTIONS = ["$search", "$expand", "$apply", "$compute", "$levels", "$skiptoken", "$inlinecount", "$deltatoken"];

/**
 * Interpreta as opcoes de consulta. Lanca `ODataOptionError` (400/501) para `$filter`/`$orderby` invalidos ou em
 * backend sem suporte e para opcoes nao implementadas ($apply, $search, $expand, ...): nunca as ignora.
 */
export function planODataQuery(
  params: URLSearchParams,
  columns: ODataColumn[],
  ref: (c: ODataColumn) => string,
  supported: boolean,
): ODataQueryPlan {
  const warnings: string[] = [];
  let where: string | null = null;
  let orderBy: string | null = null;

  for (const o of UNSUPPORTED_OPTIONS) {
    if (params.get(o) !== null) throw new ODataOptionError(501, "ODATA_OPTION_NOT_SUPPORTED", `${o} nao e suportado por este servico OData. Remova a opcao (o Catworld nao a ignora: devolveria dado diferente do pedido).`);
  }
  const filter = params.get("$filter");
  if (filter?.trim()) {
    if (!supported) throw new ODataOptionError(501, "ODATA_OPTION_NOT_SUPPORTED", "$filter nao e suportado nesta fonte (SQL Server). Remova o filtro ou consulte via SQL (POST /api/v1/queries).");
    try { where = translateFilter(filter, columns, ref); }
    catch (e) { throw new ODataOptionError(400, "ODATA_INVALID_QUERY", `$filter invalido: ${e instanceof UnsupportedODataOption ? e.message : "expressao invalida"}`); }
  }
  const ob = params.get("$orderby");
  if (ob?.trim()) {
    if (!supported) throw new ODataOptionError(501, "ODATA_OPTION_NOT_SUPPORTED", "$orderby nao e suportado nesta fonte (SQL Server). Remova a ordenacao ou consulte via SQL (POST /api/v1/queries).");
    try { orderBy = translateOrderBy(ob, columns, ref); }
    catch (e) { throw new ODataOptionError(400, "ODATA_INVALID_QUERY", `$orderby invalido: ${e instanceof UnsupportedODataOption ? e.message : "expressao invalida"}`); }
  }
  return { where, orderBy, warnings };
}
