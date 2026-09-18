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

export function translateTsql(input: string, target: SqlTarget): ContractTranslation {
  if (target === "mssql") return { sql: input.trim(), topLimit: null };
  return toPostgres(input);
}

// ---------------------------------------------------------------------------
// T-SQL -> Postgres
// ---------------------------------------------------------------------------

function toPostgres(input: string): ContractTranslation {
  const { text, quoted } = protectBracketIdentifiers(stripNolock(input));
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
  const root = stmts[0];

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
  return { sql: restoreIdentifiers(out, quoted), topLimit };
}

function stripNolock(sql: string): string {
  return mapOutsideLiterals(sql, (s) => s.replace(/\bWITH\s*\(\s*NOLOCK\s*\)/gi, ""));
}

function rejectKnownUnsupported(sql: string): void {
  if (mapOutsideLiterals(sql, (s) => (s.includes("::") ? "::" : "")).includes("::")) {
    throw new SqlContractError("O cast '::' e sintaxe Postgres; use CAST(x AS tipo) ou CONVERT(tipo, x).", { construct: "::" });
  }
  const bad = mapOutsideLiterals(sql, (s) => s).match(/\b(TRY_CAST|TRY_CONVERT|TRY_PARSE|PIVOT|UNPIVOT|OPENQUERY|OPENROWSET|FOR\s+XML|FOR\s+JSON|CROSS\s+APPLY|OUTER\s+APPLY)\b/i);
  if (bad) {
    throw new SqlContractError(
      `${bad[1]!.toUpperCase()} nao faz parte do subconjunto T-SQL garantido pelo Catworld para este backend.`,
      { construct: bad[1]!.toUpperCase() },
    );
  }
}

// ---------------------------------------------------------------------------
// Identificadores
// ---------------------------------------------------------------------------

const SENTINEL = "cwq_";

/** `[Nome Col]` -> `cwq_0`, guardando o nome exato; literais e comentarios intactos. */
function protectBracketIdentifiers(sql: string): { text: string; quoted: string[] } {
  const quoted: string[] = [];
  const text = mapOutsideLiterals(sql, (s) =>
    s.replace(/\[([^\]]+)\]/g, (_m, name: string) => {
      quoted.push(name);
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

  // 'a' + 'b' (concatenacao T-SQL) -> ||
  if (n.type === "binary_expr" && n.operator === "+" && (isText(n.left) || isText(n.right))) {
    n.operator = "||";
  }

  if (n.type === "cast" && Array.isArray(n.target)) {
    for (const t of n.target) {
      const params = t.length != null && t.length !== "max" ? [String(t.length), ...(t.scale != null ? [String(t.scale)] : [])] : [];
      t.dataType = mssqlTypeToPg(String(t.dataType), params);
      t.length = null;
      t.scale = null;
      t.parentheses = false;
      t.suffix = [];
    }
    return n;
  }

  if (n.type === "function" && n.name?.name) return transformFunction(n);
  return n;
}

const isText = (e: Node): boolean =>
  !!e && (e.type === "single_quote_string" || e.type === "string" || e.type === "var_string" ||
    (e.type === "binary_expr" && e.operator === "||") ||
    (e.type === "function" && ["CONCAT", "LTRIM", "RTRIM", "UPPER", "LOWER", "SUBSTRING", "REPLACE"].includes(fname(e))));

const DATE_UNIT: Record<string, string> = {
  year: "year", yy: "year", yyyy: "year", quarter: "quarter", qq: "quarter", q: "quarter",
  month: "month", mm: "month", m: "month", day: "day", dd: "day", d: "day",
  hour: "hour", hh: "hour", minute: "minute", mi: "minute", n: "minute",
  second: "second", ss: "second", s: "second",
};

function unitOf(a: Node, fn: string): string {
  const key = String(a?.column ?? a?.value ?? "").toLowerCase();
  const u = DATE_UNIT[key];
  if (!u) throw new SqlContractError(`${fn}: unidade '${key}' fora do subconjunto garantido (year, quarter, month, day, hour, minute, second).`);
  return u;
}

function transformFunction(n: Node): Node {
  const f = fname(n);
  const a = args(n);
  switch (f) {
    case "ISNULL": n.name.name[0].value = "COALESCE"; return n;
    case "LEN": n.name.name[0].value = "LENGTH"; return n;
    case "GETDATE": case "SYSDATETIME": return raw("LOCALTIMESTAMP");
    case "GETUTCDATE": case "SYSUTCDATETIME": return raw("(NOW() AT TIME ZONE 'UTC')");
    case "NEWID": return raw("gen_random_uuid()");
    case "IIF": return raw(`(CASE WHEN ${emit(a[0])} THEN ${emit(a[1])} ELSE ${emit(a[2])} END)`);
    case "YEAR": case "MONTH": case "DAY":
      return raw(`EXTRACT(${f} FROM ${ts(a[0])})::INT`);
    case "DATEPART": {
      const u = unitOf(a[0], "DATEPART");
      return raw(`EXTRACT(${u} FROM ${ts(a[1])})::INT`);
    }
    case "DATEADD": {
      const u = unitOf(a[0], "DATEADD");
      return raw(`(${ts(a[2])} + (${emit(a[1])}) * INTERVAL '1 ${u}')`);
    }
    case "DATEDIFF": {
      const u = unitOf(a[0], "DATEDIFF");
      const s = ts(a[1]);
      const e = ts(a[2]);
      // T-SQL conta FRONTEIRAS cruzadas (nao intervalos completos)
      if (u === "day") return raw(`(CAST(${e} AS DATE) - CAST(${s} AS DATE))`);
      if (u === "year") return raw(`(EXTRACT(YEAR FROM ${e}) - EXTRACT(YEAR FROM ${s}))::BIGINT`);
      if (u === "quarter") return raw(`((EXTRACT(YEAR FROM ${e}) - EXTRACT(YEAR FROM ${s})) * 4 + EXTRACT(QUARTER FROM ${e}) - EXTRACT(QUARTER FROM ${s}))::BIGINT`);
      if (u === "month") return raw(`((EXTRACT(YEAR FROM ${e}) - EXTRACT(YEAR FROM ${s})) * 12 + EXTRACT(MONTH FROM ${e}) - EXTRACT(MONTH FROM ${s}))::BIGINT`);
      const div = u === "hour" ? 3600 : u === "minute" ? 60 : 1;
      return raw(`((EXTRACT(EPOCH FROM date_trunc('${u}', CAST(${e} AS TIMESTAMP))) - EXTRACT(EPOCH FROM date_trunc('${u}', CAST(${s} AS TIMESTAMP)))) / ${div})::BIGINT`);
    }
    case "CHARINDEX":
      if (a.length !== 2) throw new SqlContractError("CHARINDEX com posicao inicial (3 argumentos) nao faz parte do subconjunto garantido.");
      return raw(`POSITION(${emit(a[0])} IN ${emit(a[1])})`);
    case "CONVERT": return transformConvert(a);
    case "STR": return raw(`(${emit(a[0])})::TEXT`);
    default: return n;
  }
}

const CONVERT_STYLE: Record<number, string> = {
  23: "YYYY-MM-DD", 120: "YYYY-MM-DD HH24:MI:SS", 121: "YYYY-MM-DD HH24:MI:SS.MS",
  112: "YYYYMMDD", 103: "DD/MM/YYYY", 101: "MM/DD/YYYY", 108: "HH24:MI:SS",
};

function transformConvert(a: Node[]): Node {
  if (a.length < 2) throw new SqlContractError("CONVERT exige (tipo, expressao).");
  const t = a[0];
  const typeName = t.type === "function" ? fname(t) : String(t.column ?? t.value ?? "");
  const typeArg = t.type === "function" ? args(t) : [];
  const pgType = mssqlTypeToPg(typeName, typeArg.map((x) => String(x.value)));
  if (a.length >= 3) {
    const style = Number(a[2].value);
    const fmt = CONVERT_STYLE[style];
    if (!fmt || pgType !== "TEXT") {
      throw new SqlContractError(`CONVERT com estilo ${a[2].value} fora do subconjunto garantido (estilos 23, 101, 103, 108, 112, 120, 121 para texto).`);
    }
    return raw(`to_char(${emit(a[1])}, '${fmt}')`);
  }
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
