/**
 * Contrato de SQL do Catworld: o usuario escreve T-SQL, em qualquer caminho
 * (storage MSSQL, storage Postgres, live). Este modulo valida e traduz.
 *
 * - target "mssql": T-SQL roda como esta (o SQL Server e a autoridade da sintaxe).
 * - target "postgres": o T-SQL e parseado (node-sql-parser, dialeto transactsql),
 *   transformado no AST e re-emitido em Postgres. Construcao fora do subconjunto
 *   suportado vira SqlContractError (UNSUPPORTED_CONSTRUCT) — nunca erro cru do banco.
 *
 * O parser so LE T-SQL; a emissao Postgres (TOP, ISNULL, DATEADD, CONVERT...) e
 * feita aqui, com trechos verbatim via nos `{type:"default"}`.
 *
 * Semantica emulada (alem da sintaxe): NULL ordena como no T-SQL (ASC primeiro / DESC ultimo), LIKE ignora caixa,
 * LEN ignora espacos finais, CAST/CONVERT para inteiro trunca e `'1' + 2` continua aritmetico.
 * NAO emulado (documentado): `=`, IN, GROUP BY, DISTINCT e JOIN em texto continuam sensiveis a caixa no Postgres.
 *
 * Identificadores: `[colchetes]` mantem caixa exata (colunas do storage PG sao
 * criadas com caixa exata); os sem colchetes saem em minusculas, como o Postgres
 * ja dobrava antes deste contrato.
 */
import { Parser } from "node-sql-parser";
import { ApiError } from "@/server/http";

export type SqlTarget = "mssql" | "postgres";

export class SqlContractError extends ApiError {
  constructor(message: string, details?: unknown) {
    super(400, "UNSUPPORTED_CONSTRUCT", message, details);
  }
}

export interface ContractTranslation {
  sql: string;
  /** TOP N do SELECT mais externo (nao emitido como LIMIT — quem pagina decide). */
  topLimit: number | null;
}

const parser = new Parser();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

const raw = (value: string): Node => ({ type: "default", value });
/** raw com tipo conhecido: `numeric` = resultado numerico (`LEN(x) + '5'` e soma); `text` = texto (`+` concatena). */
const numRaw = (value: string): Node => ({ ...raw(value), numeric: true });
const textRaw = (value: string): Node => ({ ...raw(value), text: true });

export interface TranslateOptions {
  /**
   * SQL Server: AVG sobre coluna INTEIRA devolve inteiro (media truncada). Padrao `false`: o Catworld devolve a media
   * exata (numerico) e DOCUMENTA a diferenca — emular muda numeros que clientes ja consomem. `true` emula (so AVG sem OVER).
   */
  avgTruncatesIntegers?: boolean;
}

let opts: TranslateOptions = {};

export function translateTsql(input: string, target: SqlTarget, options: TranslateOptions = {}): ContractTranslation {
  if (target === "mssql") return { sql: input.trim(), topLimit: null };
  opts = options;
  try {
    return toPostgres(input);
  } finally {
    opts = {};
  }
}

// ---------------------------------------------------------------------------
// T-SQL -> Postgres
// ---------------------------------------------------------------------------

function toPostgres(input: string): ContractTranslation {
  const { text: protectedText0, quoted } = protectBracketIdentifiers(stripNolock(input));
  // O parser trata a barra invertida de um literal como escape (mysql): '' fecharia mal a string e produziria SQL
  // errado em silencio. No T-SQL a barra e um caractere comum: troca por um sentinela durante o parse e restaura na saida.
  const protectedText = mapLiteralSegments(protectedText0, (lit) => lit.replaceAll("\\", BS));
  // COUNT_BIG(x) = COUNT(x): o count do Postgres ja e bigint
  const text = mapOutsideLiterals(rewriteTryCast(protectedText), (x) => x.replace(/\bCOUNT_BIG\s*\(/gi, "COUNT("));
  rejectKnownUnsupported(text);

  let ast: Node;
  try {
    ast = parser.astify(text, { database: "transactsql" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SqlContractError(
      `SQL fora do subconjunto T-SQL suportado pelo Catworld: ${msg.split("\n")[0]!.slice(0, 200)}`,
    );
  }
  const stmts: Node[] = Array.isArray(ast) ? ast : [ast];
  if (stmts.length !== 1) throw new SqlContractError("Apenas uma instrucao SQL e permitida");
  let root = stmts[0];
  root = wrapUnionTops(root);
  markRecursive(root);

  let topLimit: number | null = null;
  if (root.type === "select" && root.top && !root._next && !root.top.percent) {
    topLimit = Number(root.top.value);
    root.top = null;
  }

  transform(root);
  let out: string;
  try {
    out = parser.sqlify(root, { database: "postgresql" });
  } catch (err) {
    throw new SqlContractError(
      `Nao foi possivel traduzir o SQL para Postgres: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { sql: restoreIdentifiers(out, quoted).replaceAll(BS, "\\"), topLimit };
}

function stripNolock(sql: string): string {
  return mapOutsideLiterals(sql, (s) => s.replace(/\bWITH\s*\(\s*NOLOCK\s*\)/gi, ""));
}

function rejectKnownUnsupported(sql: string): void {
  if (mapOutsideLiterals(sql, (s) => (s.includes("::") ? "::" : "")).includes("::")) {
    throw new SqlContractError("O cast '::' e sintaxe Postgres; use CAST(x AS tipo) ou CONVERT(tipo, x).", { construct: "::" });
  }
  const bad = mapOutsideLiterals(sql, (s) => s).match(/\b(TRY_PARSE|PIVOT|UNPIVOT|OPENQUERY|OPENROWSET|FOR\s+XML|FOR\s+JSON)\b/i);
  if (bad) {
    throw new SqlContractError(
      `${bad[1]!.toUpperCase()} nao faz parte do subconjunto T-SQL garantido pelo Catworld para este backend.`,
      { construct: bad[1]!.toUpperCase() },
    );
  }
  const outside = mapLiteralSegments(sql, () => "''"); // literais esvaziados: palavras dentro de strings nao contam
  if (/\bNATURAL\s+(?:(?:INNER|LEFT|RIGHT|FULL)\s+(?:OUTER\s+)?)?JOIN\b/i.test(outside)) {
    throw new SqlContractError("NATURAL JOIN nao existe em T-SQL; use JOIN ... ON.", { construct: "NATURAL JOIN" });
  }
  if (/\bESCAPE\s*(?:N)?'/i.test(outside)) {
    throw new SqlContractError("LIKE ... ESCAPE nao faz parte do subconjunto T-SQL garantido pelo Catworld para este backend (use [%] / [_] para casar % e _ literais).", { construct: "LIKE ESCAPE" });
  }
  const fn = new RegExp(`\\b(${UNSUPPORTED_FUNCTIONS.join("|")})\\s*\\(`, "i").exec(outside);
  if (fn) {
    throw new SqlContractError(
      `${fn[1]!.toUpperCase()}() nao faz parte do subconjunto T-SQL garantido pelo Catworld para este backend (nao ha equivalente exato no Postgres).`,
      { construct: fn[1]!.toUpperCase() },
    );
  }
}

/** Funcoes T-SQL sem equivalente exato: erro claro (UNSUPPORTED_CONSTRUCT) em vez de "function does not exist" do banco. */
const UNSUPPORTED_FUNCTIONS = [
  "FORMAT", "DATENAME", "ISNUMERIC", "ISDATE", "STRING_SPLIT", "PATINDEX", "STUFF", "QUOTENAME", "CHOOSE", "PARSE",
  "HASHBYTES", "CHECKSUM", "BINARY_CHECKSUM", "DATETIMEFROMPARTS", "SYSDATETIMEOFFSET", "SWITCHOFFSET", "DATETRUNC",
  "DATEDIFF_BIG", "JSON_VALUE", "JSON_QUERY", "OPENJSON", "ISJSON", "TRANSLATE", "STRING_AGG",
];

// ---------------------------------------------------------------------------
// Identificadores
// ---------------------------------------------------------------------------

const SENTINEL = "cwq_";
/** Substitui a barra invertida dentro de literais durante o parse (caractere privado, nunca presente em SQL real). */
const BS = String.fromCharCode(0xe000);
const unbs = (v: unknown): string => String(v).replaceAll(BS, "\\");

/** `[Nome Col]` e `"Nome Col"` -> `cwq_0`, guardando o nome exato (identificador delimitado preserva a caixa). */
function protectBracketIdentifiers(sql: string): { text: string; quoted: string[] } {
  const quoted: string[] = [];
  const text = mapOutsideLiterals(sql, (s) =>
    s.replace(/\[([^\]]+)\]|"((?:[^"]|"")+)"/g, (_m, br: string | undefined, dq: string | undefined) => {
      quoted.push(br ?? dq!.replace(/""/g, '"'));
      return `${SENTINEL}${quoted.length - 1}_`;
    }),
  );
  return { text, quoted };
}

const PG_RESERVED = new Set([
  "user", "order", "group", "table", "select", "from", "where", "limit", "offset", "end", "all",
  "analyse", "analyze", "and", "any", "array", "as", "asc", "both", "case", "cast", "check",
  "collate", "column", "constraint", "create", "default", "desc", "distinct", "do", "else",
  "except", "false", "fetch", "for", "foreign", "grant", "having", "in", "initially", "intersect",
  "into", "leading", "not", "null", "on", "only", "or", "placing", "primary", "references",
  "returning", "some", "symmetric", "then", "to", "trailing", "true", "union", "unique", "using",
  "variadic", "when", "window", "with",
]);

/** Pos-processa a saida do sqlify (que cita tudo): sentinelas -> caixa exata; resto -> minusculo. */
function restoreIdentifiers(sql: string, quoted: string[]): string {
  return mapOutsideLiterals(sql, (s) =>
    s.replace(/"((?:[^"]|"")*)"/g, (_m, id: string) => {
      const sm = new RegExp(`^${SENTINEL}(\\d+)_$`, "i").exec(id);
      if (sm) return `"${quoted[Number(sm[1])]!.replace(/"/g, '""')}"`;
      const lower = id.toLowerCase();
      return /^[a-z_][a-z0-9_]*$/.test(lower) && !PG_RESERVED.has(lower) ? lower : `"${lower.replace(/"/g, '""')}"`;
    }),
  );
}

// ---------------------------------------------------------------------------
// Transformacao do AST
// ---------------------------------------------------------------------------

const fname = (n: Node): string => String(n.name?.name?.[0]?.value ?? "").toUpperCase();
const args = (n: Node): Node[] => n.args?.value ?? [];

function emit(n: Node): string {
  const a = parser.astify("SELECT 1", { database: "postgresql" });
  const s: Node = Array.isArray(a) ? a[0] : a;
  s.columns = [{ expr: n, as: null }];
  return parser.sqlify(s, { database: "postgresql" }).replace(/^SELECT /, "");
}

/** Literal de data ('2026-01-01') chega como `unknown` no Postgres: EXTRACT/aritmetica ficam ambiguos sem tipo. */
function ts(n: Node): string {
  const lit = n?.type === "single_quote_string" || n?.type === "string" || n?.type === "var_string";
  return lit ? `CAST(${emit(n)} AS TIMESTAMP)` : emit(n);
}

function transform(n: Node): Node {
  if (Array.isArray(n)) {
    for (let i = 0; i < n.length; i++) n[i] = transform(n[i]);
    return n;
  }
  if (!n || typeof n !== "object") return n;

  for (const k of Object.keys(n)) n[k] = transform(n[k]);

  // TOP em subquery/CTE -> LIMIT (o TOP do SELECT mais externo ja foi extraido)
  if (n.type === "select" && n.top && !n.top.percent && !n.limit) {
    n.limit = { seperator: "", value: [{ type: "number", value: Number(n.top.value) }] };
    n.top = null;
  } else if (n.type === "select" && n.top?.percent) {
    throw new SqlContractError("TOP ... PERCENT nao faz parte do subconjunto T-SQL garantido.");
  }

  // 'a' + 'b' (concatenacao T-SQL) -> ||   (e `int + '5'` NAO e concatenacao: ver rejectAmbiguousPlus)
  if (n.type === "binary_expr" && n.operator === "+") {
    rejectAmbiguousPlus(n);
    if ((isText(n.left) || isText(n.right)) && !isNumeric(n.left) && !isNumeric(n.right)) n.operator = "||";
  }

  // LIKE do SQL Server: ignora caixa (collation CI), NAO tem escape padrao (a barra invertida e literal) e aceita
  // classes [a-c] / [^a-c]. O LIKE do Postgres e sensivel a caixa, escapa com \ e nao conhece classes.
  if (n.type === "binary_expr" && (n.operator === "LIKE" || n.operator === "NOT LIKE")) return likeExpr(n);

  // NULL: no T-SQL e o MENOR valor (ASC = primeiro, DESC = ultimo); no Postgres e o contrario por padrao.
  if (Array.isArray(n.orderby)) {
    for (const item of n.orderby) {
      if (item && typeof item === "object" && !item.nulls) item.nulls = item.type === "DESC" ? "NULLS LAST" : "NULLS FIRST";
    }
  }

  if (typeof n.join === "string" && /APPLY$/i.test(n.join)) {
    if (/^OUTER/i.test(n.join)) { n.join = "LEFT JOIN LATERAL"; n.on = raw("TRUE"); }
    else n.join = "CROSS JOIN LATERAL";
    return n;
  }

  if (n.type === "cast" && Array.isArray(n.target)) {
    for (const t of n.target) {
      const trunc = varcharTruncation(t);
      if (trunc !== null && n.target.length === 1) return textRaw(`LEFT(CAST(${emit(n.expr)} AS TEXT), ${trunc})`);
      const params = t.length != null && t.length !== "max" ? [String(t.length), ...(t.scale != null ? [String(t.scale)] : [])] : [];
      t.dataType = mssqlTypeToPg(String(t.dataType), params);
      if (INT_TYPES.has(t.dataType) && n.target.length === 1) return raw(intCast(emit(n.expr), t.dataType));
      t.length = null;
      t.scale = null;
      t.parentheses = false;
      t.suffix = [];
    }
    return n;
  }

  if (n.type === "function" && n.name?.name) return transformFunction(n);

  // AVG(coluna inteira) devolve inteiro no SQL Server (opcional: ver TranslateOptions.avgTruncatesIntegers)
  if (opts.avgTruncatesIntegers && n.type === "aggr_func" && String(n.name).toUpperCase() === "AVG" && !n.over && n.args?.expr) {
    const avg = emit(n);
    const min = emit({ ...n, name: "MIN" });
    return raw(`(CASE WHEN pg_typeof(${min})::text IN ('integer', 'bigint', 'smallint') THEN TRUNC(${avg}) ELSE ${avg} END)`);
  }
  return n;
}

const isNumber = (e: Node): boolean => e?.type === "number";

/** Funcoes cujo resultado e sempre numerico: `LEN(x) + '5'` e aritmetica, nunca concatenacao. */
const NUMERIC_FUNCTIONS = new Set(["LEN", "DATEDIFF", "DATEPART", "YEAR", "MONTH", "DAY", "CHARINDEX", "ABS", "ROUND", "FLOOR", "CEILING", "COUNT", "SUM", "AVG", "MIN_NUM"]);
const isNumeric = (e: Node): boolean =>
  isNumber(e) || (e?.type === "aggr_func" && ["COUNT", "SUM", "AVG"].includes(String(e.name).toUpperCase())) ||
  (e?.type === "function" && NUMERIC_FUNCTIONS.has(fname(e))) ||
  (e?.type === "binary_expr" && ["*", "/", "-", "%"].includes(e.operator)) ||
  e?.numeric === true;

const isStringLiteral = (e: Node): boolean => e?.type === "single_quote_string" || e?.type === "string" || e?.type === "var_string";
const NUMERIC_LOOKING = /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/;

/**
 * `col + '5'`: no SQL Server, se col e numerico e aritmetica (col + 5); se e texto, concatenacao ('...5'). Sem o tipo da
 * coluna nao ha como saber — antes virava concatenacao em silencio (int + '5' = '15' em vez de 6). Literal que nao
 * parece numero ('abc', ' ') continua concatenando (com numero o SQL Server daria erro).
 */
function rejectAmbiguousPlus(n: Node): void {
  const [lit, other] = isStringLiteral(n.left) ? [n.left, n.right] : isStringLiteral(n.right) ? [n.right, n.left] : [null, null];
  if (!lit) return;
  const v = String(lit.value).replace(/''/g, "'");
  if (!NUMERIC_LOOKING.test(v)) return;
  if (isText(other) || isNumeric(other) || isStringLiteral(other)) return;
  throw new SqlContractError(
    `Expressao ambigua: <coluna> + '${v}'. No SQL Server e soma se a coluna for numerica e concatenacao se for texto; o Catworld nao ve o tipo da coluna aqui. Escreva CONCAT(coluna, '${v}') (texto) ou CAST(coluna AS BIGINT) + ${v} (numero).`,
    { construct: "+ ambiguo" },
  );
}

/** Tamanho de truncamento de CAST/CONVERT para VARCHAR(n) (SQL Server trunca em silencio; sem n = 30). null = sem truncar. */
function varcharTruncation(t: Node): number | null {
  const type = String(t.dataType ?? "").toUpperCase();
  if (!["VARCHAR", "NVARCHAR", "CHAR", "NCHAR"].includes(type)) return null;
  if (t.length === "max" || String(t.length).toLowerCase() === "max") return null;
  const len = t.length == null ? 30 : Number(t.length);
  return Number.isInteger(len) && len > 0 ? len : null;
}

// ---- LIKE ----

const REGEX_META = /[.*+?^${}()|\\[\]\/]/g;

/**
 * Padrao LIKE do T-SQL -> regex POSIX (ARE) ancorada. `%` = .*, `_` = ., `[a-c]` / `[^a-c]` = classe; todo o resto
 * e literal (inclusive a barra invertida). `[` sem `]` correspondente e literal. Exportada para teste.
 */
export function likeToRegex(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "%") out += ".*";
    else if (c === "_") out += ".";
    else if (c === "[") {
      const close = pattern.indexOf("]", i + 2 > pattern.length ? i + 1 : i + 2); // "[]" nao fecha: o 1o "]" e membro
      if (close < 0) { out += "\\["; continue; }
      let body = pattern.slice(i + 1, close);
      let neg = "";
      if (body.startsWith("^")) { neg = "^"; body = body.slice(1); }
      if (body === "") { out += "\\["; continue; }
      out += `[${neg}${body.replace(/[\\\[\]]/g, (m) => `\\${m}`)}]`;
      i = close;
    } else out += c.replace(REGEX_META, "\\$&");
  }
  return `^${out}$`;
}

const hasBracketLiteral = (e: Node): boolean => {
  if (!e || typeof e !== "object") return false;
  if (isStringLiteral(e)) return String(e.value).includes("[");
  return Object.values(e).some((v) => (Array.isArray(v) ? v.some(hasBracketLiteral) : typeof v === "object" && hasBracketLiteral(v)));
};

function likeExpr(n: Node): Node {
  const neg = n.operator === "NOT LIKE";
  const left = emit(n.left);
  if (isStringLiteral(n.right)) {
    const pat = unbs(n.right.value).replace(/''/g, "'");
    if (pat.includes("[")) return raw(`(${left} ${neg ? "!~*" : "~*"} '${likeToRegex(pat).replace(/'/g, "''")}')`);
    return raw(`(${left} ${neg ? "NOT ILIKE" : "ILIKE"} ${emit(n.right)} ESCAPE '')`);
  }
  if (hasBracketLiteral(n.right)) {
    throw new SqlContractError(
      "LIKE com classe [..] em padrao montado por expressao ('...[a-c]...' + coluna) nao e garantido: use um padrao literal.",
      { construct: "LIKE [] dinamico" },
    );
  }
  // padrao dinamico: caixa e barra corrigidas; classes [..] vindas de DADOS sao tratadas como texto literal
  return raw(`(${left} ${neg ? "NOT ILIKE" : "ILIKE"} ${emit(n.right)} ESCAPE '')`);
}

// ---- TOP dentro de UNION / CTE recursivo ----

/** `SELECT TOP n ... UNION ...`: cada ramo com TOP vira `SELECT * FROM (SELECT ... LIMIT n) t` (LIMIT solto valeria para a uniao toda). */
function wrapUnionTops(root: Node): Node {
  if (!root?._next) return root;
  let counter = 0;
  const wrapOne = (sel: Node): Node => {
    const tpl = parser.astify("SELECT * FROM (SELECT 1 AS x) AS cw_top_" + counter++, { database: "transactsql" });
    const wrapper: Node = Array.isArray(tpl) ? tpl[0] : tpl;
    const inner: Node = { ...sel, _next: undefined, set_op: undefined, with: null, orderby: null, limit: null };
    if (inner.top?.percent) throw new SqlContractError("TOP ... PERCENT nao faz parte do subconjunto T-SQL garantido.");
    inner.limit = { seperator: "", value: [{ type: "number", value: Number(inner.top.value) }] };
    inner.top = null;
    wrapper.from[0].expr.ast = inner;
    wrapper.with = sel.with ?? null;
    wrapper.orderby = sel.orderby ?? null;
    wrapper.limit = sel.limit ?? null;
    wrapper._next = sel._next;
    wrapper.set_op = sel.set_op;
    return wrapper;
  };
  let head = root;
  if (head.top) head = wrapOne(head);
  for (let s: Node = head; s?._next; s = s._next) {
    if (s._next.top) s._next = wrapOne(s._next);
  }
  return head;
}

/** T-SQL escreve `WITH c AS (... UNION ALL ... FROM c)`; o Postgres exige `WITH RECURSIVE`. */
function markRecursive(node: Node): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach(markRecursive); return; }
  if (Array.isArray(node.with)) {
    for (const w of node.with) {
      const name = String(w?.name?.value ?? "").toLowerCase();
      if (name && refersToTable(w.stmt?.ast, name)) { node.with[0].recursive = true; break; }
    }
  }
  for (const v of Object.values(node)) if (v && typeof v === "object") markRecursive(v);
}

function refersToTable(node: Node, name: string): boolean {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some((x) => refersToTable(x, name));
  if (typeof node.table === "string" && node.table.toLowerCase() === name && !node.db && !("column" in node)) return true;
  return Object.values(node).some((v) => v && typeof v === "object" && refersToTable(v, name));
}
const isText = (e: Node): boolean =>
  !!e && (e.type === "single_quote_string" || e.type === "string" || e.type === "var_string" ||
    (e.type === "binary_expr" && e.operator === "||") ||
    e.text === true ||
    (e.type === "function" && ["CONCAT", "LTRIM", "RTRIM", "UPPER", "LOWER", "SUBSTRING", "REPLACE"].includes(fname(e))));

const DATE_UNIT: Record<string, string> = {
  year: "year", yy: "year", yyyy: "year", quarter: "quarter", qq: "quarter", q: "quarter",
  month: "month", mm: "month", m: "month", day: "day", dd: "day", d: "day",
  hour: "hour", hh: "hour", minute: "minute", mi: "minute", n: "minute",
  second: "second", ss: "second", s: "second",
  week: "week", wk: "week", ww: "week",
  weekday: "weekday", dw: "weekday", w: "weekday",
  dayofyear: "dayofyear", dy: "dayofyear", y: "dayofyear",
};

function unitOf(a: Node, fn: string): string {
  const key = String(a?.column ?? a?.value ?? "").toLowerCase();
  const u = DATE_UNIT[key];
  if (!u) throw new SqlContractError(`${fn}: unidade '${key}' fora do subconjunto garantido (year, quarter, month, week, weekday, dayofyear, day, hour, minute, second).`);
  return u;
}

function transformFunction(n: Node): Node {
  const f = fname(n);
  const a = args(n);
  switch (f) {
    case "ISNULL": n.name.name[0].value = "COALESCE"; return n;
    case "LEN": return numRaw(`LENGTH(RTRIM(CAST(${emit(a[0])} AS TEXT)))`); // T-SQL: LEN ignora espacos finais
    // NOW() (instante) e nao LOCALTIMESTAMP / AT TIME ZONE 'UTC': estes devolvem horario SEM fuso, que o driver
    // le como horario local do processo e desloca o valor quando app e banco tem fusos diferentes.
    case "GETDATE": case "SYSDATETIME": case "GETUTCDATE": case "SYSUTCDATETIME": return raw("NOW()");
    case "NEWID": return raw("gen_random_uuid()");
    case "IIF": return raw(`(CASE WHEN ${emit(a[0])} THEN ${emit(a[1])} ELSE ${emit(a[2])} END)`);
    case "YEAR": case "MONTH": case "DAY":
      return numRaw(`EXTRACT(${f} FROM ${ts(a[0])})::INT`);
    case "DATEPART": {
      const u = unitOf(a[0], "DATEPART");
      const x = ts(a[1]);
      // Semana e dia da semana no padrao do SQL Server (DATEFIRST 7: domingo = 1)
      if (u === "weekday") return numRaw(`(EXTRACT(DOW FROM ${x}) + 1)::INT`);
      if (u === "dayofyear") return numRaw(`EXTRACT(DOY FROM ${x})::INT`);
      if (u === "week") return numRaw(`(FLOOR((EXTRACT(DOY FROM ${x}) - 1 + EXTRACT(DOW FROM date_trunc('year', CAST(${x} AS TIMESTAMP)))) / 7) + 1)::INT`);
      return numRaw(`EXTRACT(${u} FROM ${x})::INT`);
    }
    case "DATEADD": {
      const u = unitOf(a[0], "DATEADD");
      // SQL Server converte o numero para INT (DATEADD(day, 1.5, d) soma 1 dia) e nao tem intervalo "quarter" no Postgres (= 3 meses)
      const cnt = isNumber(a[1]) ? `(${Math.trunc(Number(a[1].value))})` : `TRUNC(CAST(${emit(a[1])} AS NUMERIC))`;
      const [mult, iu] = u === "quarter" ? [3, "month"] : u === "weekday" || u === "dayofyear" ? [1, "day"] : [1, u];
      const sum = `(${ts(a[2])} + ${cnt} * ${mult === 1 ? "" : `${mult} * `}INTERVAL '1 ${iu}')`;
      // DATE de entrada (CAST(x AS DATE) explicito) continua DATE quando a unidade e de data (o tipo de coluna nao e visivel aqui: ver docs)
      const dateUnit = ["year", "quarter", "month", "week", "day", "weekday", "dayofyear"].includes(u);
      const isCastDate = a[2]?.type === "cast" && Array.isArray(a[2].target) && String(a[2].target[0]?.dataType).toUpperCase() === "DATE";
      return raw(dateUnit && isCastDate ? `CAST(${sum} AS DATE)` : sum);
    }
    case "DATEDIFF": {
      let u = unitOf(a[0], "DATEDIFF");
      if (u === "weekday" || u === "dayofyear") u = "day"; // no DATEDIFF equivalem a dia
      const s = ts(a[1]);
      const e = ts(a[2]);
      // T-SQL conta FRONTEIRAS cruzadas (nao intervalos completos)
      if (u === "day") return raw(`(CAST(${e} AS DATE) - CAST(${s} AS DATE))`);
      // Semanas comecam no domingo; 1900-01-07 foi um domingo
      if (u === "week") return raw(`(((CAST(${e} AS DATE) - DATE '1900-01-07') / 7) - ((CAST(${s} AS DATE) - DATE '1900-01-07') / 7))::BIGINT`);
      if (u === "year") return raw(`(EXTRACT(YEAR FROM ${e}) - EXTRACT(YEAR FROM ${s}))::BIGINT`);
      if (u === "quarter") return raw(`((EXTRACT(YEAR FROM ${e}) - EXTRACT(YEAR FROM ${s})) * 4 + EXTRACT(QUARTER FROM ${e}) - EXTRACT(QUARTER FROM ${s}))::BIGINT`);
      if (u === "month") return raw(`((EXTRACT(YEAR FROM ${e}) - EXTRACT(YEAR FROM ${s})) * 12 + EXTRACT(MONTH FROM ${e}) - EXTRACT(MONTH FROM ${s}))::BIGINT`);
      const div = u === "hour" ? 3600 : u === "minute" ? 60 : 1;
      return raw(`((EXTRACT(EPOCH FROM date_trunc('${u}', CAST(${e} AS TIMESTAMP))) - EXTRACT(EPOCH FROM date_trunc('${u}', CAST(${s} AS TIMESTAMP)))) / ${div})::BIGINT`);
    }
    case "CHARINDEX": {
      if (a.length !== 2 && a.length !== 3) throw new SqlContractError("CHARINDEX exige 2 ou 3 argumentos.");
      // Collation CI do SQL Server: a busca ignora a caixa. CHARINDEX('', x) = 0 (POSITION daria 1).
      const needle = `LOWER(CAST(${emit(a[0])} AS TEXT))`;
      const hay = `LOWER(CAST(${emit(a[1])} AS TEXT))`;
      const emptyGuard = (r: string) => (isStringLiteral(a[0]) && String(a[0].value) !== "" ? r : `(CASE WHEN ${needle} = '' THEN 0 ELSE ${r} END)`);
      if (a.length === 2) return numRaw(emptyGuard(`POSITION(${needle} IN ${hay})`));
      const start = emit(a[2]);
      return numRaw(emptyGuard(`(CASE WHEN POSITION(${needle} IN SUBSTRING(${hay} FROM ${start})) = 0 THEN 0 ELSE POSITION(${needle} IN SUBSTRING(${hay} FROM ${start})) + ${start} - 1 END)`));
    }
    case "REPLACE": {
      if (a.length !== 3) return n;
      const str = emit(a[0]);
      // Colacao CI: REPLACE('Ana', 'a', 'x') = 'xnx'. Sem letras no alvo a caixa nao importa e o REPLACE nativo basta.
      if (isStringLiteral(a[1]) && !/[A-Za-z\u00C0-\u024F]/.test(String(a[1].value))) return n;
      const find = emit(a[1]);
      const repl = emit(a[2]);
      const esc = String.raw`regexp_replace(CAST(${find} AS TEXT), '([.*+?^$(){}|\[\]\\])', '\\\1', 'g')`;
      const escRepl = String.raw`replace(CAST(${repl} AS TEXT), '\', '\\')`;
      return textRaw(`(CASE WHEN CAST(${find} AS TEXT) = '' THEN CAST(${str} AS TEXT) ELSE regexp_replace(CAST(${str} AS TEXT), ${esc}, ${escRepl}, 'gi') END)`);
    }
    case "REPLICATE": case "SPACE": {
      const isSpace = f === "SPACE";
      if (a.length !== (isSpace ? 1 : 2)) throw new SqlContractError(`${f} exige ${isSpace ? 1 : 2} argumento(s).`);
      const cnt = emit(a[isSpace ? 0 : 1]);
      return textRaw(`(CASE WHEN ${cnt} < 0 THEN NULL ELSE REPEAT(${isSpace ? "' '" : `CAST(${emit(a[0])} AS TEXT)`}, CAST(${cnt} AS INTEGER)) END)`);
    }
    case "EOMONTH": {
      if (a.length !== 1 && a.length !== 2) throw new SqlContractError("EOMONTH exige 1 ou 2 argumentos.");
      const months = a.length === 2 ? ` + (${emit(a[1])}) * INTERVAL '1 month'` : "";
      return raw(`CAST(date_trunc('month', ${ts(a[0])}${months}) + INTERVAL '1 month' - INTERVAL '1 day' AS DATE)`);
    }
    case "DATEFROMPARTS": {
      if (a.length !== 3) throw new SqlContractError("DATEFROMPARTS exige 3 argumentos.");
      return raw(`MAKE_DATE(CAST(${emit(a[0])} AS INTEGER), CAST(${emit(a[1])} AS INTEGER), CAST(${emit(a[2])} AS INTEGER))`);
    }
    case "CW_TRYCAST": return tryCast(a);
    case "CONVERT": return transformConvert(a);
    case "STR": return raw(`(${emit(a[0])})::TEXT`);
    default: return n;
  }
}

/**
 * TRY_CAST/TRY_CONVERT: o parser nao os aceita; reescrevemos para CW_TRYCAST(expr, 'tipo') antes do parse.
 * So tipos numericos sao emulaveis com seguranca (CASE + regex); os demais dao erro explicito.
 */
function rewriteTryCast(sql: string): string {
  let out = sql;
  for (let guard = 0; guard < 50; guard++) {
    const m = /\bTRY_(CAST|CONVERT)\s*\(/i.exec(out);
    if (!m) return out;
    const open = m.index + m[0].length;
    const close = matchingParen(out, open - 1);
    if (close < 0) throw new SqlContractError("TRY_CAST/TRY_CONVERT com parenteses desbalanceados.");
    const inner = out.slice(open, close);
    let expr: string;
    let type: string;
    if (m[1]!.toUpperCase() === "CAST") {
      const at = lastTopLevelAs(inner);
      if (at < 0) throw new SqlContractError("TRY_CAST exige (expressao AS tipo).");
      expr = inner.slice(0, at).trim();
      type = inner.slice(at + 2).trim();
    } else {
      const parts = splitTopLevel(inner);
      if (parts.length !== 2) throw new SqlContractError("TRY_CONVERT com estilo fora do subconjunto garantido.");
      type = parts[0]!.trim();
      expr = parts[1]!.trim();
    }
    out = `${out.slice(0, m.index)}CW_TRYCAST(${expr}, '${type.replace(/'/g, "''")}')${out.slice(close + 1)}`;
  }
  throw new SqlContractError("TRY_CAST/TRY_CONVERT aninhados demais.");
}

function skipString(s: string, i: number): number {
  // i aponta para a aspa de abertura; devolve o indice da aspa de fechamento
  i++;
  while (i < s.length) {
    if (s[i] === "'" && s[i + 1] === "'") { i += 2; continue; }
    if (s[i] === "'") return i;
    i++;
  }
  return i;
}

function matchingParen(sql: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") { i = skipString(sql, i); continue; }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

function lastTopLevelAs(s: string): number {
  let depth = 0;
  let last = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") { i = skipString(s, i); continue; }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && /^\sAS\s/i.test(s.slice(i, i + 4))) last = i + 1;
  }
  return last;
}

function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") { i = skipString(s, i); continue; }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) { parts.push(s.slice(cur, i)); cur = i + 1; }
  }
  parts.push(s.slice(cur));
  return parts;
}

const INT_RE = String.raw`^\s*[-+]?[0-9]+\s*$`;
const NUM_RE = String.raw`^\s*[-+]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][-+]?[0-9]+)?\s*$`;

function tryCast(a: Node[]): Node {
  const typeText = String(a[1]?.value ?? "");
  const m = /^\s*([A-Za-z_]+)\s*(?:\(([^)]*)\))?\s*$/.exec(typeText);
  if (!m) throw new SqlContractError(`TRY_CAST: tipo '${typeText}' invalido.`);
  const name = m[1]!.toUpperCase();
  const isInt = ["INT", "INTEGER", "BIGINT", "SMALLINT", "TINYINT"].includes(name);
  const isNum = ["DECIMAL", "NUMERIC", "FLOAT", "REAL", "MONEY", "SMALLMONEY"].includes(name);
  if (!isInt && !isNum) {
    throw new SqlContractError(`TRY_CAST/TRY_CONVERT para ${name} fora do subconjunto garantido (so tipos numericos).`);
  }
  const pgType = mssqlTypeToPg(name, m[2] ? m[2].split(",").map((x) => x.trim()) : []);
  const x = emit(a[0]);
  const txt = `CAST(${x} AS TEXT)`;
  // SQL Server: TRY_CAST('') = 0 (vazio/so espacos convertem para zero nos tipos numericos)
  const blank = `WHEN TRIM(${txt}) = '' THEN '0'`;
  // O CAST fica POR FORA do CASE: com literal, o Postgres dobra CAST('abc' AS INT) no planejamento e erra.
  if (!isInt) return raw(`CAST((CASE WHEN ${txt} ~ '${NUM_RE}' THEN TRIM(${txt}) ${blank} END) AS ${pgType})`);
  // Inteiro: operando NUMERICO trunca (TRY_CAST(10.5 AS INT) = 10); TEXTO com ponto decimal nao converte ('10.5' -> NULL);
  // fora da faixa do tipo -> NULL (o CAST cru do Postgres estouraria com erro).
  const numericOperand = `pg_typeof(${x})::text IN ('numeric', 'double precision', 'real', 'integer', 'bigint', 'smallint')`;
  const clean = `(CASE WHEN ${txt} ~ '${INT_RE}' THEN TRIM(${txt}) WHEN ${numericOperand} AND ${txt} ~ '${NUM_RE}' THEN TRIM(${txt}) ${blank} END)`;
  const [lo, hi] = pgType === "BIGINT" ? ["-9223372036854775808", "9223372036854775807"] : pgType === "SMALLINT" ? (name === "TINYINT" ? ["0", "255"] : ["-32768", "32767"]) : ["-2147483648", "2147483647"];
  const v = `TRUNC(CAST(${clean} AS NUMERIC))`;
  return raw(`CAST((CASE WHEN ${v} BETWEEN ${lo} AND ${hi} THEN ${v} END) AS ${pgType})`);
}

const INT_TYPES = new Set(["INTEGER", "BIGINT", "SMALLINT"]);

/** T-SQL: CAST(2.7 AS INT) = 2 (trunca); Postgres arredonda para 3. */
function intCast(x: string, pgType: string): string {
  return `CAST(TRUNC(CAST(${x} AS NUMERIC)) AS ${pgType})`;
}

const CONVERT_STYLE: Record<number, string> = {
  23: "YYYY-MM-DD", 120: "YYYY-MM-DD HH24:MI:SS", 121: "YYYY-MM-DD HH24:MI:SS.MS",
  112: "YYYYMMDD", 103: "DD/MM/YYYY", 101: "MM/DD/YYYY", 108: "HH24:MI:SS",
  102: "YYYY.MM.DD", 104: "DD.MM.YYYY", 105: "DD-MM-YYYY", 110: "MM-DD-YYYY", 111: "YYYY/MM/DD",
  8: "HH24:MI:SS", 24: "HH24:MI:SS", 20: "YYYY-MM-DD HH24:MI:SS", 21: "YYYY-MM-DD HH24:MI:SS.MS",
  126: 'YYYY-MM-DD"T"HH24:MI:SS.MS', 127: 'YYYY-MM-DD"T"HH24:MI:SS.MS',
};

function transformConvert(a: Node[]): Node {
  if (a.length < 2) throw new SqlContractError("CONVERT exige (tipo, expressao).");
  const t = a[0];
  const typeName = t.type === "function" ? fname(t) : String(t.column ?? t.value ?? "");
  const typeArg = t.type === "function" ? args(t) : [];
  const pgType = mssqlTypeToPg(typeName, typeArg.map((x) => String(x.value)));
  const trunc = varcharTruncation({ dataType: typeName, length: typeArg.length ? typeArg[0]!.value : null });
  const clip = (e: string) => (trunc === null ? e : `LEFT(${e}, ${trunc})`);
  if (a.length >= 3) {
    const style = Number(a[2].value);
    const fmt = CONVERT_STYLE[style];
    if (!fmt || pgType !== "TEXT") {
      throw new SqlContractError(`CONVERT com estilo ${a[2].value} fora do subconjunto garantido (estilos 8, 20, 21, 23, 24, 101, 102, 103, 104, 105, 108, 110, 111, 112, 120, 121, 126, 127 para texto).`);
    }
    // CONVERT(VARCHAR(10), dt, 120) = so a data: o SQL Server trunca o texto do estilo ao tamanho declarado
    return textRaw(clip(`to_char(${emit(a[1])}, '${fmt}')`));
  }
  if (trunc !== null) return textRaw(clip(`CAST(${emit(a[1])} AS TEXT)`));
  if (INT_TYPES.has(pgType)) return raw(intCast(emit(a[1]), pgType));
  return raw(`CAST(${emit(a[1])} AS ${pgType})`);
}

export function mssqlTypeToPg(type: string, params: string[] = []): string {
  const t = type.trim().toUpperCase();
  const p = params.length ? `(${params.join(",")})` : "";
  if (/^N?(VAR)?CHAR$/.test(t) || t === "NVARCHAR" || t === "VARCHAR" || t === "TEXT" || t === "NTEXT") return "TEXT";
  if (t === "INT" || t === "INTEGER") return "INTEGER";
  if (t === "BIGINT") return "BIGINT";
  if (t === "SMALLINT" || t === "TINYINT") return "SMALLINT";
  if (t === "BIT") return "BOOLEAN";
  if (t === "FLOAT" || t === "REAL") return "DOUBLE PRECISION";
  if (t === "DECIMAL" || t === "NUMERIC") return `DECIMAL${p}`;
  if (t === "MONEY" || t === "SMALLMONEY") return "DECIMAL(19,4)";
  if (t === "DATETIME" || t === "DATETIME2" || t === "SMALLDATETIME") return "TIMESTAMP";
  if (t === "DATE") return "DATE";
  if (t === "TIME") return "TIME";
  if (t === "DATETIMEOFFSET") return "TIMESTAMPTZ";
  if (t === "UNIQUEIDENTIFIER") return "UUID";
  if (t === "VARBINARY" || t === "BINARY" || t === "IMAGE") return "BYTEA";
  throw new SqlContractError(`Tipo '${type}' fora do subconjunto garantido.`);
}

// ---------------------------------------------------------------------------
// Utilitario: aplica fn so dentro de literais '...' / N'...' (o inverso de mapOutsideLiterals)
// ---------------------------------------------------------------------------

export function mapLiteralSegments(sql: string, fn: (lit: string) => string): string {
  let i = 0;
  let out = "";
  let last = 0;
  while (i < sql.length) {
    const isN = sql[i] === "N" && sql[i + 1] === "'";
    if (isN || sql[i] === "'") {
      out += sql.slice(last, i);
      const start = i;
      if (isN) i++;
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      out += fn(sql.slice(start, i));
      last = i;
    } else i++;
  }
  return out + sql.slice(last);
}

// ---------------------------------------------------------------------------
// Utilitario: aplica fn so fora de literais '...' / N'...'
// ---------------------------------------------------------------------------

export function mapOutsideLiterals(sql: string, fn: (s: string) => string): string {
  const parts: string[] = [];
  let i = 0;
  let last = 0;
  while (i < sql.length) {
    const isN = sql[i] === "N" && sql[i + 1] === "'";
    if (isN || sql[i] === "'") {
      parts.push(sql.slice(last, i));
      const start = i;
      if (isN) i++;
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      parts.push(sql.slice(start, i));
      last = i;
    } else i++;
  }
  parts.push(sql.slice(last));
  return parts.map((p, idx) => (idx % 2 === 0 ? fn(p) : p)).join("");
}
