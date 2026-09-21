/**
 * Formato numérico decimal por COLUNA (TIP-01/TIP-02, docs/estudo-confiabilidade-dados.md).
 *
 * Regra: a convenção (ponto ou vírgula como separador DECIMAL; o outro é milhar) é decidida uma vez por coluna, olhando o arquivo
 * inteiro — nunca por valor. Um valor com os dois separadores, ou um separador repetido, ou um separador sozinho com != 3 dígitos
 * depois, fixa a convenção. Um separador sozinho seguido de exatamente 3 dígitos (`1,234`) é ambíguo (1234 ou 1,234): se nada na
 * coluna desambigua, a coluna NÃO vira número (fica TEXT) em vez de adivinhar.
 *
 * Nada aqui passa por Number/parseFloat: a saída é a string canônica (`-1234.5600`, ponto decimal, sem milhar).
 */
import { fitDecimal, DECIMAL_MAX_PRECISION, type DecimalSpec } from "@/lib/decimal-type";

export type DecSep = "." | ",";
const BIGINT_MIN = -9223372036854775808n, BIGINT_MAX = 9223372036854775807n;

const RE_HYP: Record<DecSep, RegExp> = {
  //          sinal   parte inteira: 0 | sem zero à esquerda | agrupada por milhar          fração
  ".": /^(-?)(0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)(?:\.(\d+))?$/,
  ",": /^(-?)(0|[1-9]\d*|[1-9]\d{0,2}(?:\.\d{3})+)(?:,(\d+))?$/,
};

/** Interpreta `raw` supondo que `dec` é o separador decimal; devolve a string canônica ou null se o formato não se encaixa. */
export function decimalUnderHypothesis(raw: string, dec: DecSep): string | null {
  const t = raw.trim();
  const m = RE_HYP[dec].exec(t);
  if (!m) return null;
  const thousands = dec === "." ? "," : ".";
  const intPart = m[2]!.replaceAll(thousands, "");
  // inteiro puro (sem separador) só vale se couber em BIGINT — números enormes continuam sendo texto exato
  if (m[3] === undefined && !t.includes(",") && !t.includes(".")) {
    try { const b = BigInt(t); if (b < BIGINT_MIN || b > BIGINT_MAX) return null; } catch { return null; }
  }
  return `${m[1]}${intPart}${m[3] !== undefined ? "." + m[3] : ""}`;
}

/**
 * Converte para a forma canônica usando a convenção da coluna. Sem convenção (mapeamentos antigos, gerados antes desta regra):
 * usa o critério legado (o último separador é o decimal), mas SEM Number e validando o formato.
 */
export function canonicalDecimal(raw: string, sep?: DecSep | null): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (sep === "." || sep === ",") return decimalUnderHypothesis(s, sep);
  const lastDot = s.lastIndexOf("."), lastComma = s.lastIndexOf(",");
  const cleaned = lastComma > lastDot ? s.replaceAll(".", "").replace(",", ".") : s.replaceAll(",", "");
  return /^-?(?:\d+|\d+\.\d+)$/.test(cleaned) ? cleaned : null;
}

/** Acumulador por coluna: quais convenções ainda são possíveis, se há valor ambíguo, e a maior parte inteira/escala de cada uma. */
export type DecimalAcc = {
  ok: Record<DecSep, boolean>;
  maxInt: Record<DecSep, number>;
  maxScale: Record<DecSep, number>;
  ambiguous: boolean;
};

export const newDecimalAcc = (): DecimalAcc => ({
  ok: { ".": true, ",": true }, maxInt: { ".": 1, ",": 1 }, maxScale: { ".": 0, ",": 0 }, ambiguous: false,
});

export function accumulateDecimal(acc: DecimalAcc, value: string): void {
  const c: Record<DecSep, string | null> = { ".": null, ",": null };
  for (const h of [".", ","] as const) {
    if (!acc.ok[h]) continue;
    const canon = decimalUnderHypothesis(value, h);
    c[h] = canon;
    if (canon === null) { acc.ok[h] = false; continue; }
    const [i, f = ""] = canon.replace("-", "").split(".");
    acc.maxInt[h] = Math.max(acc.maxInt[h], i!.replace(/^0+(?=\d)/, "").length || 1);
    acc.maxScale[h] = Math.max(acc.maxScale[h], f.replace(/0+$/, "").length);
  }
  if (c["."] !== null && c[","] !== null && c["."] !== c[","]) acc.ambiguous = true;
}

export type DecimalVerdict =
  | { kind: "decimal"; sep: DecSep; spec: DecimalSpec }
  | { kind: "ambiguous" }       // as duas convenções servem para todos os valores e dão números diferentes: não adivinhar
  | { kind: "too-wide" }        // não cabe em 38 dígitos: TEXT
  | { kind: "none" };           // algum valor não é decimal

/**
 * Piso (18,4): mantém o tipo legado quando os dados cabem nele (tabelas existentes e appends continuam compatíveis);
 * só alarga quando o arquivo exige, respeitando o teto de 38 dígitos.
 */
export function widenToLegacyFloor(spec: DecimalSpec): DecimalSpec {
  const intDigits = spec.precision - spec.scale;
  const scale = Math.max(spec.scale, 4);
  let wantInt = Math.max(intDigits, 14);
  if (wantInt + scale > DECIMAL_MAX_PRECISION) wantInt = Math.max(intDigits, DECIMAL_MAX_PRECISION - scale);
  return { precision: wantInt + scale, scale };
}

export function decideDecimal(acc: DecimalAcc): DecimalVerdict {
  const dot = acc.ok["."], comma = acc.ok[","];
  if (!dot && !comma) return { kind: "none" };
  if (dot && comma && acc.ambiguous) return { kind: "ambiguous" };
  const sep: DecSep = dot ? "." : ",";
  // fitDecimal decide se cabe (usa o maior inteiro e a maior escala observados, em texto)
  const probe = "9".repeat(acc.maxInt[sep]) + (acc.maxScale[sep] ? "." + "9".repeat(acc.maxScale[sep]) : "");
  const fit = fitDecimal([probe]);
  if (!fit) return { kind: "too-wide" };
  return { kind: "decimal", sep, spec: widenToLegacyFloor(fit) };
}
