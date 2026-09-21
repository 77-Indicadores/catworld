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

const PG_KIND: Record<number, ColumnKind> = {
  1082: "date", 1114: "datetime", 1184: "datetime", 1083: "time", 1266: "time",
  20: "bigint", 1700: "decimal", 17: "binary",
};

export const pgKind = (oid: number): ColumnKind => PG_KIND[oid] ?? "other";

export function mssqlKind(declaration: string | undefined): ColumnKind {
  switch ((declaration ?? "").toLowerCase()) {
    case "date": return "date";
    case "datetime": case "datetime2": case "smalldatetime": case "datetimeoffset": return "datetime";
    case "time": return "time";
    case "bigint": return "bigint";
    case "decimal": case "numeric": case "money": case "smallmoney": return "decimal";
    case "binary": case "varbinary": case "image": return "binary";
    default: return "other";
  }
}

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
