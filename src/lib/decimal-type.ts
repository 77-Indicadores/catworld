/**
 * Tipo canônico DECIMAL(p,s): a precisão e a escala fazem parte do tipo (antes tudo era DECIMAL(18,4) fixo, o que arredondava
 * escala > 4 e virava NULL acima de 14 dígitos inteiros — ver docs/estudo-confiabilidade-dados.md, TIP-01/FON-04).
 *
 * Compatível com o legado: `DECIMAL(18,4)` continua sendo `NUMERIC(18,4)`; um `DECIMAL` sem parâmetros também.
 * Sem dependências de servidor (roda no navegador e no worker).
 */
export const DECIMAL_MAX_PRECISION = 38; // teto comum ao Postgres e ao SQL Server
export const DECIMAL_LEGACY = { precision: 18, scale: 4 } as const;

export type DecimalSpec = { precision: number; scale: number };

const RE = /^\s*(?:DECIMAL|NUMERIC)\s*\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)\s*$/i;

/** `DECIMAL(p,s)` → especificação; `DECIMAL` sem parâmetros → legado (18,4); qualquer outra coisa → null. */
export function parseDecimalType(sqlType: string): DecimalSpec | null {
  const m = RE.exec(sqlType);
  if (m) {
    const precision = Number(m[1]), scale = Number(m[2]);
    if (precision < 1 || precision > DECIMAL_MAX_PRECISION || scale < 0 || scale > precision) return null;
    return { precision, scale };
  }
  if (/^\s*(?:DECIMAL|NUMERIC)\s*$/i.test(sqlType)) return { ...DECIMAL_LEGACY };
  return null;
}

export const formatDecimalType = (s: DecimalSpec) => `DECIMAL(${s.precision},${s.scale})`;

/** Tipo físico (`NUMERIC(p,s)` no Postgres, `DECIMAL(p,s)` no SQL Server). Parâmetros inválidos caem no legado, nunca em TEXT. */
export function physicalDecimal(sqlType: string, dialect: "postgres" | "mssql"): string {
  const s = parseDecimalType(sqlType) ?? DECIMAL_LEGACY;
  return `${dialect === "postgres" ? "NUMERIC" : "DECIMAL"}(${s.precision},${s.scale})`;
}

/**
 * Menor DECIMAL(p,s) que guarda TODOS os valores, ou null se nenhum cabe (mais de 38 dígitos): quem chama deve então usar TEXT,
 * nunca arredondar nem descartar. Valores no formato `-1234.5600` (sinal opcional, ponto como decimal, sem separador de milhar).
 */
export function fitDecimal(values: Iterable<string>): DecimalSpec | null {
  let intDigits = 1, scale = 0;
  for (const raw of values) {
    const m = /^[-+]?(\d*)(?:\.(\d*))?$/.exec(raw.trim());
    if (!m || (m[1] === "" && (m[2] ?? "") === "")) return null;
    const i = (m[1] ?? "").replace(/^0+(?=\d)/, "").length || 1;
    // zeros à direita da escala não contam (1.5000 e 1.5 cabem em escala 1)
    const f = (m[2] ?? "").replace(/0+$/, "").length;
    intDigits = Math.max(intDigits, i);
    scale = Math.max(scale, f);
  }
  const precision = intDigits + scale;
  return precision > DECIMAL_MAX_PRECISION ? null : { precision: Math.max(precision, 1), scale };
}

/** O valor cabe no tipo sem arredondar nem estourar? (validação exata em texto, sem passar por Number). */
export function decimalFits(value: string, spec: DecimalSpec): boolean {
  const m = /^[-+]?(\d*)(?:\.(\d*))?$/.exec(value.trim());
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) return false;
  const i = (m[1] ?? "").replace(/^0+(?=\d)/, "").length;
  const f = (m[2] ?? "").replace(/0+$/, "").length;
  return f <= spec.scale && i <= spec.precision - spec.scale;
}

/**
 * Arredonda (meio para cima, em texto — nunca passa por Number) um valor com mais casas decimais que `spec.scale`
 * para caber em `spec`. `null` se nem arredondando cabe (dígitos inteiros a mais: isso é estouro de verdade, não
 * arredondamento). Uso: SOMENTE colunas de mapeamento antigo (já existiam com um DECIMAL(p,s) fixo antes da coluna
 * ganhar `decimalDigits` do arquivo inteiro) — é o comportamento que sempre existiu e automações de anos dependem
 * dele (incidente em produção, 2026-09-22: falhar em vez de arredondar quebrou cargas que sempre funcionaram).
 * Colunas novas (com `decimalDigits`) continuam alargando o tipo em vez de arredondar — ver `isWideDecimal`.
 */
export function legacyRoundDecimal(value: string, spec: DecimalSpec): string | null {
  const m = /^([-+]?)(\d*)(?:\.(\d*))?$/.exec(value.trim());
  if (!m) return null;
  const sign = m[1] === "-" ? "-" : "";
  const intPart = (m[2] ?? "") || "0";
  const frac = m[3] ?? "";
  if (frac.length <= spec.scale) return decimalFits(value, spec) ? value.trim() : null;
  const keep = frac.slice(0, spec.scale);
  const roundUp = frac.charCodeAt(spec.scale) >= 53; // '5'
  // Junta parte inteira + casas mantidas num único inteiro (BigInt, nunca float) e soma 1 se precisa arredondar
  // — o próprio BigInt cuida do "vai um" propagando por todos os dígitos (99.99 -> 100.0 na escala 1, etc.).
  const digits = BigInt(intPart + keep) + (roundUp ? 1n : 0n);
  let digitsStr = digits.toString();
  if (digitsStr.length <= spec.scale) digitsStr = digitsStr.padStart(spec.scale + 1, "0");
  const newIntPart = digitsStr.slice(0, digitsStr.length - spec.scale) || "0";
  const newFrac = spec.scale > 0 ? digitsStr.slice(digitsStr.length - spec.scale) : "";
  if (newIntPart.length > spec.precision - spec.scale) return null; // arredondar transbordou os dígitos inteiros: estouro real, não é só arredondamento
  const result = spec.scale > 0 ? `${sign}${newIntPart}.${newFrac}` : `${sign}${newIntPart}`;
  return decimalFits(result, spec) ? result : null;
}
