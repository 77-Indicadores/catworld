/**
 * Marca d'agua (delta) de fontes incrementais (FON-01/02/03/14).
 *
 * Problemas que este modulo fecha:
 *  - `>` estrito perdia linhas com valor IGUAL a marca (empates) e commits tardios: agora le `>= marca - janela` e o upsert por
 *    chave torna a sobreposicao inofensiva;
 *  - linhas com delta NULL nunca eram lidas: agora entram em toda rodada (`OR col IS NULL`), o upsert e idempotente;
 *  - um valor no futuro (2099) congelava a fonte: a marca nunca passa de `relogio da origem + tolerancia`;
 *  - a marca vinha de `Date` (fuso do processo, ms): agora e texto canonico UTC com microssegundos, vindo do valor cru.
 */
import { formatTimestamp, parseTemporal } from "./source-values";

export type DeltaKind = "temporal" | "integer" | "decimal" | "text";
export type Dialect = "postgres" | "mssql";

export const DEFAULT_LOOKBACK_MINUTES = 10;
export const DEFAULT_FUTURE_TOLERANCE_HOURS = 24;

export function deltaKindOf(sqlType: string): DeltaKind {
  if (sqlType === "DATE" || sqlType === "DATETIME2") return "temporal";
  if (sqlType === "BIGINT") return "integer";
  if (sqlType.startsWith("DECIMAL")) return "decimal";
  return "text";
}

/** Marca gravada (inclusive o formato antigo ISO com Z) -> forma canonica; ilegivel -> null (quem chama recarrega tudo). */
export function normalizeWatermark(raw: string | null | undefined, kind: DeltaKind): string | null {
  if (raw == null || raw === "") return null;
  if (kind === "temporal") {
    const t = parseTemporal(raw);
    return t ? formatTimestamp(t) : null;
  }
  if (kind === "integer") return /^-?\d+$/.test(raw.trim()) ? raw.trim() : null;
  if (kind === "decimal") return /^-?\d+(\.\d+)?$/.test(raw.trim()) ? raw.trim() : null;
  return raw;
}

function cmpDecimal(a: string, b: string): number {
  const [ai = "0", af = ""] = a.replace(/^-/, "").split(".");
  const [bi = "0", bf = ""] = b.replace(/^-/, "").split(".");
  const w = Math.max(af.length, bf.length);
  const x = BigInt(ai + af.padEnd(w, "0")) * (a.startsWith("-") ? -1n : 1n);
  const y = BigInt(bi + bf.padEnd(w, "0")) * (b.startsWith("-") ? -1n : 1n);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function compareWatermark(a: string, b: string, kind: DeltaKind): number {
  if (kind === "integer") { const x = BigInt(a), y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0; }
  if (kind === "decimal") return cmpDecimal(a, b);
  return a < b ? -1 : a > b ? 1 : 0; // temporal canonico (largura fixa) e texto: ordem lexicografica
}

/** Limite superior aceitavel da marca: relogio da origem + tolerancia (so temporal). */
export function deltaCap(sourceNow: Date | string, toleranceHours = DEFAULT_FUTURE_TOLERANCE_HOURS): string | null {
  const iso = sourceNow instanceof Date ? sourceNow.toISOString() : sourceNow;
  const t = parseTemporal(iso);
  if (!t) return null;
  const ms = Date.UTC(t.y, t.mo - 1, t.d, t.h, t.mi, t.s) + toleranceHours * 3_600_000;
  const u = new Date(ms);
  return formatTimestamp({ y: u.getUTCFullYear(), mo: u.getUTCMonth() + 1, d: u.getUTCDate(), h: u.getUTCHours(), mi: u.getUTCMinutes(), s: u.getUTCSeconds(), frac: t.frac });
}

/** A marca ja gravada esta alem do limite (foi contaminada por um valor futuro numa versao anterior)? */
export const isFutureWatermark = (wm: string, kind: DeltaKind, cap: string | null) => kind === "temporal" && !!cap && compareWatermark(wm, cap, kind) > 0;

/** Acumula o maior valor de delta lido, ignorando (e contando) os que passam do limite. */
export class WatermarkTracker {
  max: string | null = null;
  futureCount = 0;
  futureMax: string | null = null;
  nullCount = 0;
  constructor(private kind: DeltaKind, private cap: string | null) {}
  push(canonical: string | null): void {
    if (canonical == null) { this.nullCount++; return; }
    if (this.kind === "temporal" && this.cap && compareWatermark(canonical, this.cap, this.kind) > 0) {
      this.futureCount++;
      if (this.futureMax == null || compareWatermark(canonical, this.futureMax, this.kind) > 0) this.futureMax = canonical;
      return;
    }
    if (this.max == null || compareWatermark(canonical, this.max, this.kind) > 0) this.max = canonical;
  }
  warning(column: string): string | null {
    if (!this.futureCount) return null;
    return `DELTA_FUTURE_VALUES: ${this.futureCount} linha(s) com "${column}" no futuro (maior: ${this.futureMax}); a marca d'agua foi limitada ao relogio da origem para a fonte nao congelar. Corrija esses valores na origem.`;
  }
}

/** Limite inferior lido: marca menos a janela de sobreposicao (so temporal). */
export function lowerBound(wm: string, kind: DeltaKind, lookbackMinutes: number): string {
  if (kind !== "temporal" || lookbackMinutes <= 0) return wm;
  const t = parseTemporal(wm);
  if (!t) return wm;
  const u = new Date(Date.UTC(t.y, t.mo - 1, t.d, t.h, t.mi, t.s) - lookbackMinutes * 60_000);
  if (u.getUTCFullYear() < 1) return "0001-01-01 00:00:00.000000";
  return formatTimestamp({ y: u.getUTCFullYear(), mo: u.getUTCMonth() + 1, d: u.getUTCDate(), h: u.getUTCHours(), mi: u.getUTCMinutes(), s: u.getUTCSeconds(), frac: t.frac });
}

/**
 * Predicado do incremento: `col >= limite OR col IS NULL`. Empates e NULL entram; o upsert por chave deduplica.
 * O literal e sempre validado (nunca concatena texto livre sem escapar).
 */
export function buildDeltaPredicate(o: { kind: DeltaKind; quotedColumn: string; watermark: string; dialect: Dialect; lookbackMinutes?: number }): string {
  const { kind, quotedColumn: col, watermark, dialect } = o;
  const lb = lowerBound(watermark, kind, o.lookbackMinutes ?? DEFAULT_LOOKBACK_MINUTES);
  let lit: string;
  if (kind === "temporal") {
    const iso = lb.replace(" ", "T");
    lit = dialect === "mssql" ? `CAST('${iso}' AS DATETIME2(7))` : `'${lb}'::timestamp`;
  } else if (kind === "integer" || kind === "decimal") {
    lit = watermark;
  } else {
    lit = `'${lb.replace(/'/g, "''")}'`;
  }
  return `(${col} >= ${lit} OR ${col} IS NULL)`;
}
