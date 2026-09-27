/**
 * Contrato de resultado: os 4 executores (storage MSSQL/PG, live MSSQL/PG) devolvem
 * o mesmo formato JSON para o mesmo tipo logico de coluna.
 *
 *   date      -> "YYYY-MM-DD"
 *   datetime  -> ISO-8601 UTC ("2026-01-31T10:00:00.000Z")
 *   time      -> "HH:MM:SS[.fff]"
 *   bigint    -> string   (nao cabe em number JS sem perda)
 *   decimal   -> string   (idem)
 *   binary    -> base64
 *   demais    -> como o driver entrega
 *
 * O tipo logico vem do metadado da coluna (OID no pg, declaration no mssql) —
 * so assim da para distinguir DATE de DATETIME (ambos chegam como Date em JS).
 */

export type ColumnKind = "date" | "datetime" | "time" | "bigint" | "decimal" | "binary" | "other";
/** Como o driver materializa DATE em Date: pg usa meia-noite local, mssql meia-noite UTC. */
export type DriverFlavor = "pg" | "mssql";

/**
 * Familia usada para derivar o `sqlType` canonico do catalogo de fontes (ver `mapPgOid`/`mapPgType` em
 * connections/postgres.ts, `mapMssqlType` em connections/mssql.ts). Ausente = cai no fallback de texto
 * (`TEXT_TYPE`) — mesmo criterio de hoje. `money19`/`money10` sao os dois casos MSSQL com escala FIXA
 * (`money`=DECIMAL(19,4), `smallmoney`=DECIMAL(10,4)), sem depender de precision/scale do catalogo.
 */
export type TypeFamily = "bigint" | "float" | "numeric" | "money19" | "money10" | "date" | "datetime" | "time";

/**
 * Registro unico por OID do Postgres: cada linha carrega as duas facetas que hoje viviam em tabelas
 * separadas (`mapPgOid` em postgres.ts e o antigo `PG_KIND` aqui) — a familia usada pro tipo canonico
 * de SCHEMA (`sqlType`, coluna gravada) e o `ColumnKind` usado pra serializar o VALOR de um resultado de
 * query livre. As duas propositalmente DIVERGEM em alguns OIDs, porque respondem perguntas diferentes:
 *  - `timetz` (1266): schema trata como texto (o `TIME` do storage nao guarda o deslocamento, perderia
 *    dado); resultado de query trata como "time" (o valor cru ainda carrega o deslocamento certo).
 *  - `int2`/`int4` (21/23): cabem em `number` do JS sem perda, entao o resultado de query nao precisa da
 *    serializacao especial de "bigint" (essa so existe pra int8, que estoura `Number.MAX_SAFE_INTEGER`);
 *    o schema, porem, trata os tres como a mesma familia `BIGINT` (inteiro exato).
 *  - `float4`/`float8` (700/701): o resultado de query devolve o `number` como o driver ja entrega; o
 *    schema precisa do valor exato em texto (perderia precisao guardando como `number`), por isso vira
 *    `lossyNumeric`/texto no catalogo.
 * Ver `docs/source-type-mapping.md` pra tabela completa por tipo (nome), que cobre tambem os casos sem
 * OID direto (`information_schema.columns`, usado por `tableColumns`).
 */
export const PG_TYPE_REGISTRY: Record<number, { family?: TypeFamily; columnKind?: ColumnKind }> = {
  17: { columnKind: "binary" },                              // bytea
  20: { family: "bigint", columnKind: "bigint" },             // int8
  21: { family: "bigint" },                                   // int2
  23: { family: "bigint" },                                   // int4
  700: { family: "float" },                                   // float4
  701: { family: "float" },                                   // float8
  1082: { family: "date", columnKind: "date" },               // date
  1083: { family: "time", columnKind: "time" },               // time
  1114: { family: "datetime", columnKind: "datetime" },       // timestamp
  1184: { family: "datetime", columnKind: "datetime" },       // timestamptz
  1266: { columnKind: "time" },                                // timetz
  1700: { family: "numeric", columnKind: "decimal" },         // numeric
};

export const pgOidFamily = (oid: number): TypeFamily | undefined => PG_TYPE_REGISTRY[oid]?.family;
export const pgKind = (oid: number): ColumnKind => PG_TYPE_REGISTRY[oid]?.columnKind ?? "other";

/**
 * Registro unico por NOME de tipo do MSSQL (minusculo): mesma ideia do `PG_TYPE_REGISTRY`, mas aqui as
 * duas facetas usam o MESMO dominio de chave (`mapMssqlType` em mssql.ts e o antigo `mssqlKind` aqui já
 * recebiam o mesmo nome de tipo em string — não OID vs. nome como no Postgres), entao a unificacao e
 * direta, sem nenhuma faceta ficando implicita.
 */
export const MSSQL_TYPE_REGISTRY: Record<string, { family?: TypeFamily; columnKind?: ColumnKind }> = {
  bigint: { family: "bigint", columnKind: "bigint" },
  int: { family: "bigint" },
  smallint: { family: "bigint" },
  tinyint: { family: "bigint" },
  decimal: { family: "numeric", columnKind: "decimal" },
  numeric: { family: "numeric", columnKind: "decimal" },
  money: { family: "money19", columnKind: "decimal" },
  smallmoney: { family: "money10", columnKind: "decimal" },
  float: { family: "float" },
  real: { family: "float" },
  date: { family: "date", columnKind: "date" },
  datetime: { family: "datetime", columnKind: "datetime" },
  datetime2: { family: "datetime", columnKind: "datetime" },
  smalldatetime: { family: "datetime", columnKind: "datetime" },
  datetimeoffset: { family: "datetime", columnKind: "datetime" },
  time: { family: "time", columnKind: "time" },
  binary: { columnKind: "binary" },
  varbinary: { columnKind: "binary" },
  image: { columnKind: "binary" },
};

export const mssqlTypeFamily = (dataType: string): TypeFamily | undefined => MSSQL_TYPE_REGISTRY[dataType.toLowerCase()]?.family;
export const mssqlKind = (declaration: string | undefined): ColumnKind => MSSQL_TYPE_REGISTRY[(declaration ?? "").toLowerCase()]?.columnKind ?? "other";

const p2 = (n: number) => String(n).padStart(2, "0");

// ---------------------------------------------------------------------------
// Datas/horas do Postgres como TEXTO (ver storage/pg-types.ts): independentes do fuso do Node, com microssegundos e
// 'infinity'. O parser padrao do `pg` (Date) foi a causa de ENT-06.
// ---------------------------------------------------------------------------

const PG_SPECIAL = new Set(["infinity", "-infinity"]);
const PG_TS = /^(\d{4,})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2}(?::?\d{2})?)?)?$/;

/** DATE em texto do pg -> "YYYY-MM-DD" (mantem 'infinity' e datas a.C. como vieram). */
export function pgDateText(s: string): string {
  if (PG_SPECIAL.has(s) || s.endsWith(" BC")) return s;
  const m = /^\d{4,}-\d{2}-\d{2}/.exec(s); // anos com 5+ digitos (12345-01-01) nao podem ser cortados em 10 chars
  return m ? m[0] : s.slice(0, 10);
}

/**
 * TIMESTAMP/TIMESTAMPTZ em texto do pg -> ISO-8601 UTC. Sem fuso = UTC (o storage guarda relogio UTC-rotulado);
 * com offset converte para UTC. Milissegundos como sempre ("...000Z"); os 6 digitos so aparecem quando ha
 * microssegundos (nada e truncado). 'infinity' e datas a.C. passam como vieram.
 */
export function pgTimestampToIso(s: string): string {
  if (PG_SPECIAL.has(s) || s.endsWith(" BC")) return s;
  const m = PG_TS.exec(s);
  if (!m) return s;
  const frac = ((m[7] ?? "") + "000000").slice(0, 6);
  let ms = 0;
  const d = new Date(0);
  d.setUTCFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3])); // setUTC*: Date.UTC trata anos 0-99 como 1900+
  d.setUTCHours(Number(m[4]), Number(m[5]), Number(m[6]), 0);
  ms = d.getTime();
  const tz = m[8];
  if (tz && tz.toUpperCase() !== "Z") {
    const digits = tz.slice(1).replace(/:/g, "");
    const secs = Number(digits.slice(0, 2)) * 3600 + Number(digits.slice(2, 4) || "0") * 60 + Number(digits.slice(4, 6) || "0");
    ms -= (tz[0] === "-" ? -1 : 1) * secs * 1000;
  }
  const u = new Date(ms);
  const sub = frac.slice(3);
  const y = String(u.getUTCFullYear()).padStart(4, "0");
  return `${y}-${p2(u.getUTCMonth() + 1)}-${p2(u.getUTCDate())}T${p2(u.getUTCHours())}:${p2(u.getUTCMinutes())}:${p2(u.getUTCSeconds())}.${frac.slice(0, 3)}${sub === "000" ? "" : sub}Z`;
}

/**
 * Formato LEGADO (normalize=false) para colunas Postgres lidas como texto: reproduz o que um Node em UTC entregava
 * (DATE -> "YYYY-MM-DDT00:00:00.000Z"; TIMESTAMP -> ISO UTC), mas sem depender do fuso e sem perder microssegundos.
 */
export function legacyPgValue(v: unknown, kind: ColumnKind): unknown {
  if (typeof v !== "string") return v;
  if (kind === "date") { const d = pgDateText(v); return PG_SPECIAL.has(d) || d.endsWith(" BC") ? d : `${d}T00:00:00.000Z`; }
  if (kind === "datetime") return pgTimestampToIso(v);
  return v;
}

export function legacyPgRows(rows: Record<string, unknown>[], kinds: Record<string, ColumnKind>): Record<string, unknown>[] {
  const special = Object.entries(kinds).filter(([, k]) => k === "date" || k === "datetime");
  if (!special.length) return rows;
  for (const row of rows) for (const [col, kind] of special) if (col in row) row[col] = legacyPgValue(row[col], kind);
  return rows;
}

export function normalizeValue(v: unknown, kind: ColumnKind, flavor: DriverFlavor): unknown {
  if (v === null || v === undefined) return null;
  switch (kind) {
    case "date":
      if (v instanceof Date) {
        return flavor === "pg"
          ? `${v.getFullYear()}-${p2(v.getMonth() + 1)}-${p2(v.getDate())}`
          : v.toISOString().slice(0, 10);
      }
      return pgDateText(String(v));
    case "datetime":
      if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
      return typeof v === "string" && flavor === "pg" ? pgTimestampToIso(v) : v;
    case "time":
      if (v instanceof Date) {
        const ms = v.getUTCMilliseconds();
        return `${p2(v.getUTCHours())}:${p2(v.getUTCMinutes())}:${p2(v.getUTCSeconds())}${ms ? "." + String(ms).padStart(3, "0") : ""}`;
      }
      return String(v);
    case "bigint": case "decimal":
      return typeof v === "number" || typeof v === "bigint" ? String(v) : v;
    case "binary":
      return Buffer.isBuffer(v) ? v.toString("base64") : v;
    default:
      return typeof v === "bigint" ? String(v) : v;
  }
}

/**
 * Colunas cujo VALOR muda com `normalize: true` (formato legado x recomendado). Postgres ja entrega decimal e
 * bigint como string; o SQL Server entrega decimal como numero e DATE/TIME como Date.
 */
export function legacyFormatColumns(kinds: Record<string, ColumnKind>, flavor: DriverFlavor): string[] {
  const changes: ColumnKind[] = flavor === "pg" ? ["date", "binary"] : ["date", "time", "decimal", "binary"];
  return Object.entries(kinds).filter(([, k]) => changes.includes(k)).map(([n]) => n);
}

/** Normaliza as linhas in-place-friendly: so colunas com tipo logico especial sao tocadas. */
export function normalizeRows(
  rows: Record<string, unknown>[],
  kinds: Record<string, ColumnKind>,
  flavor: DriverFlavor,
): Record<string, unknown>[] {
  const special = Object.entries(kinds).filter(([, k]) => k !== "other");
  if (!special.length) return rows;
  for (const row of rows) {
    for (const [col, kind] of special) {
      if (col in row) row[col] = normalizeValue(row[col], kind, flavor);
    }
  }
  return rows;
}
