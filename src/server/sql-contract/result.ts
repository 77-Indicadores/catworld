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

export function normalizeValue(v: unknown, kind: ColumnKind, flavor: DriverFlavor): unknown {
  if (v === null || v === undefined) return null;
  switch (kind) {
    case "date":
      if (v instanceof Date) {
        return flavor === "pg"
          ? `${v.getFullYear()}-${p2(v.getMonth() + 1)}-${p2(v.getDate())}`
          : v.toISOString().slice(0, 10);
      }
      return String(v).slice(0, 10);
    case "datetime":
      return v instanceof Date ? v.toISOString() : v;
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
