/**
 * Formats a raw DB cell value for display or export.
 * Handles the mssql TIME columns that arrive as "1970-01-01T<HH:MM:SS>.000Z".
 */
export function fmtCell(v: unknown, isoDates = false): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "boolean") return v;
  // Opt-in (dateFormat=iso): sem isso, Date sai como o toString do JS (depende do fuso do servidor)
  if (isoDates && v instanceof Date) return v.toISOString();
  const s = String(v);
  const m = s.match(/^1970-01-01T(\d{2}:\d{2}:\d{2})/);
  if (m) return m[1]!;
  return s;
}

/** Variant that always returns a string (for rendering in the UI). */
export function fmtCellStr(v: unknown): string {
  const r = fmtCell(v);
  if (r === null) return "NULL";
  return String(r);
}
