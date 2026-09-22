/**
 * ENT-04 — o modo `fallback` nao pode trocar a semantica em silencio.
 *
 * Hoje, quando o motor novo REJEITA uma consulta (ou o banco falha ao executa-la), o `fallback` traduz a consulta INTEIRA
 * pelo tradutor legado (regex): LIKE vira sensivel a caixa, `DATEADD(month, n, d)` vira n*30 dias, NULL ordena ao contrario...
 * e o resultado sai como se fosse T-SQL correto. Este gate decide, ANTES de cair no legado:
 *   - `block`: o legado e CONHECIDAMENTE diferente do SQL Server nesta consulta -> nao usa; devolve o erro do motor novo
 *     (UNSUPPORTED_CONSTRUCT) acrescido do motivo;
 *   - `warn`: diferenca so visivel em casos de borda (NULL, espacos finais) -> usa o legado, MAS a resposta leva um aviso
 *     `LEGACY_TRANSLATION: ...` (o cliente/SDK passa a saber que o resultado veio do tradutor antigo).
 */
import { mapLiteralSegments } from "@/server/sql-contract/translate";

export interface LegacyGate {
  /** Motivo pelo qual o legado NAO pode ser usado (null = pode). */
  block: string | null;
  /** Diferencas de borda, avisadas no resultado quando o legado e usado. */
  warn: string[];
}

const BLOCK: { re: RegExp; why: string }[] = [
  { re: /\bN?LIKE\b/i, why: "LIKE (o tradutor antigo o executa sensivel a caixa; o SQL Server ignora a caixa e aceita classes [a-c])" },
  { re: /\b(?:DATEADD|DATEDIFF)\s*\(\s*(?:month|mm|m|quarter|qq|q|year|yy|yyyy)\s*,/i, why: "DATEADD/DATEDIFF em mes/trimestre/ano (o tradutor antigo usa 30 dias por mes)" },
  { re: /\bDATEPART\s*\(\s*(?:week|wk|ww|weekday|dw|w)\s*,/i, why: "DATEPART de semana/dia da semana (numeracao diferente da do SQL Server)" },
  { re: /\b(?:CHARINDEX|REPLACE)\s*\(/i, why: "CHARINDEX/REPLACE (o tradutor antigo diferencia maiusculas de minusculas; o SQL Server nao)" },
  { re: /\b(?:CAST|CONVERT)\s*\([^)]*\bN?VAR(?:CHAR)?\s*\(\s*\d+\s*\)/i, why: "CAST/CONVERT para VARCHAR(n) (o tradutor antigo nao trunca em n)" },
  { re: /\bTRY_(?:CAST|CONVERT)\s*\(/i, why: "TRY_CAST/TRY_CONVERT (semantica numerica diferente no tradutor antigo)" },
];

const WARN: { re: RegExp; why: string }[] = [
  { re: /\bORDER\s+BY\b/i, why: "ordem de NULL: o tradutor antigo ordena NULL por ultimo em ASC (no SQL Server, NULL e o menor valor)" },
  { re: /\bLEN\s*\(/i, why: "LEN: espacos finais podem ser contados" },
  { re: /\bISNULL\s*\(/i, why: "ISNULL: o tipo do resultado pode diferir do SQL Server" },
];

export function legacyGate(input: string): LegacyGate {
  const text = mapLiteralSegments(input, () => "''"); // palavras dentro de literais nao contam
  const hit = BLOCK.find((r) => r.re.test(text));
  return { block: hit?.why ?? null, warn: WARN.filter((r) => r.re.test(text)).map((r) => r.why) };
}

export const LEGACY_WARNING_PREFIX = "LEGACY_TRANSLATION";

/** Texto do aviso que acompanha um resultado produzido pelo tradutor antigo. */
export function legacyWarning(reason: string, gate: LegacyGate): string {
  const extra = gate.warn.length ? ` Diferencas possiveis: ${gate.warn.join("; ")}.` : "";
  return `${LEGACY_WARNING_PREFIX}: o motor SQL novo rejeitou esta consulta (${reason.slice(0, 160)}) e ela foi executada pelo tradutor antigo, que pode diferir do T-SQL.${extra} Reescreva a consulta ou defina sql_contract.mode = strict.`;
}

/** Anexa avisos ao resultado (objeto com `warnings?: string[]`). Nao altera resultados que nao sao objetos. */
export function attachWarnings<T>(result: T, warnings: string[] | undefined): T {
  if (!warnings?.length || result === null || typeof result !== "object") return result;
  const r = result as { warnings?: string[] };
  r.warnings = [...(r.warnings ?? []), ...warnings];
  return result;
}
