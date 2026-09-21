import { parseDecimalType, formatDecimalType } from "@/lib/decimal-type";

// Tipos canônicos aceitos como override — os mesmos que a inferência do parser pode produzir.
// DECIMAL(p,s) exige 1<=p<=38 e 0<=s<=p (decimal-type.ts); "DECIMAL" sem parâmetros = legado (18,4).
const OVERRIDABLE_TYPES = new Set(["BIGINT", "DATE", "DATETIME2", "TIME", "NVARCHAR(MAX)"]);

/** Tipo de override normalizado ("DECIMAL(10,2)"), ou null se inválido. Usado no parser e na validação da API (sem dependências pesadas). */
export function normalizeTypeOverride(type: string): string | null {
  const t = type.toUpperCase().trim().replace(/\s+/g, "");
  if (OVERRIDABLE_TYPES.has(t)) return t;
  if (/^(DECIMAL|NUMERIC)(\(|$)/.test(t)) { const d = parseDecimalType(t); return d ? formatDecimalType(d) : null; }
  return null;
}
