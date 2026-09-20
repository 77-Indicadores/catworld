/** Valores de resultado -> texto de CSV / celula de XLSX (bigint, decimal, Date, Buffer, objeto). */

function plain(value: unknown, iso: boolean): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : (iso ? value.toISOString() : String(value));
  if (typeof value === "bigint") return value.toString();
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return `0x${value.toString("hex")}`;
  if (typeof value === "object") return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  return String(value);
}

/** Campo CSV entre aspas. */
export function csvField(value: unknown, iso = false): string {
  const text = plain(value, iso);
  return `"${text.replaceAll('"', '""')}"`;
}

/** Celula XLSX: numeros, booleanos e datas ficam nativos; bigint/objeto/Buffer viram texto. */
export function xlsxCell(value: unknown): string | number | boolean | Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value;
  return plain(value, true);
}
