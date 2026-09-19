"use client";
import { fmtCell } from "@/lib/fmt-cell";

/** Coluna "numérica" se todo valor não nulo é número ou texto numérico (o resultado normalizado manda bigint/decimal como texto). */
export function isNumericColumn(rows: Record<string, unknown>[], column: string): boolean {
  let seen = false;
  for (const row of rows) {
    const v = row[column];
    if (v === null || v === undefined || v === "") continue;
    if (typeof v === "number") { seen = true; continue; }
    if (typeof v === "string" && /^-?\d+([.,]\d+)?$/.test(v.trim())) { seen = true; continue; }
    return false;
  }
  return seen;
}

/** Célula: NULL destacado (não confundir com o texto "NULL"), números alinhados à direita. */
export function GridCell({ value, numeric }: { value: unknown; numeric: boolean }) {
  if (value === null || value === undefined) return <td className="whitespace-nowrap italic text-base-content/50">NULL</td>;
  const text = typeof value === "object" ? JSON.stringify(value) : String(fmtCell(value) ?? "");
  return <td className={`whitespace-nowrap ${numeric ? "text-right tabular-nums" : ""}`}>{text}</td>;
}

/** Grade de resultado usada pela consulta SQL e pela aba de dados da tabela. */
export function ResultGrid({ columns, rows, numericColumns, caption }: {
  columns: string[];
  rows: Record<string, unknown>[];
  /** Colunas numéricas conhecidas (por tipo); as demais são inferidas dos valores. */
  numericColumns?: ReadonlySet<string>;
  caption?: string;
}) {
  const numeric = new Set(columns.filter((c) => numericColumns?.has(c) || isNumericColumn(rows, c)));
  return (
    <table className="table table-zebra data-grid w-full">
      {caption && <caption className="sr-only">{caption}</caption>}
      <thead>
        <tr>{columns.map((c) => <th key={c} scope="col" className={`whitespace-nowrap ${numeric.has(c) ? "text-right" : ""}`}>{c}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>{columns.map((c) => <GridCell key={c} value={row[c]} numeric={numeric.has(c)} />)}</tr>
        ))}
      </tbody>
    </table>
  );
}
