/**
 * Apresentação de contagens. O valor EXATO nunca se perde (BigInt/string); o compacto ("1,5 mi") só serve a listas
 * apertadas e sempre vem com o exato no `title`.
 */

export type CountPresentation = {
  /** `1.487.197` */
  exact: string;
  /** `1,5 mi` (abaixo de mil = exato). */
  compact: string;
  /** Texto para `title`: `1.487.197 linhas`. */
  title: string;
  value: bigint;
};

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function dec(n: number): string {
  const s = (Math.round(n * 10) / 10).toString().replace(".", ",");
  return s;
}

export function toBigInt(input: string | number | bigint | null | undefined): bigint | null {
  if (input === null || input === undefined || input === "") return null;
  try {
    if (typeof input === "number") return Number.isFinite(input) ? BigInt(Math.trunc(input)) : null;
    return BigInt(input);
  } catch {
    return null;
  }
}

/** Inteiro em pt-BR (`1.487.197`); nulo/inválido = "0". Para contagens simples (jobs, itens) e linhas em painéis. */
export function formatInt(input: string | number | bigint | null | undefined): string {
  return presentCount(input)?.exact ?? "0";
}

export function presentCount(input: string | number | bigint | null | undefined, unit = "linhas"): CountPresentation | null {
  const v = toBigInt(input);
  if (v === null) return null;
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const exact = `${neg ? "-" : ""}${group(abs.toString())}`;
  const n = Number(abs);
  let compact = exact;
  const sg = neg ? "-" : "";
  // Arredondar a 1 casa pode dar 1000 da unidade menor (999.950 -> "1000 mil"): sobe para a unidade seguinte.
  if (abs >= 999_950_000n) compact = `${sg}${dec(n / 1e9)} bi`;
  else if (abs >= 999_950n) compact = `${sg}${dec(n / 1e6)} mi`;
  else if (abs >= 10_000n) compact = `${sg}${dec(n / 1e3)} mil`;
  return { exact, compact, title: `${exact} ${v === 1n ? unit.replace(/s$/, "") : unit}`, value: v };
}

/** Decimal curto em pt-BR (1 casa no máximo): `1,5`, `12`. Para estimativas (GB, etc.), não para contagens exatas. */
export function fmtDecimal(n: number): string {
  return n.toLocaleString("pt-BR", { maximumFractionDigits: 1 });
}
