/**
 * Conversao FIEL de valores de fontes externas para o texto que o `bulkInsert` do storage recebe (FON-04/10/13).
 * Regras: nunca passar numerico por `Number`, nunca transformar valor nao vazio em NULL, nunca depender do fuso do
 * processo. O que nao cabe no tipo de destino falha com erro claro (o destino anterior permanece), nao vira NULL.
 * Mapeamento completo: docs/source-type-mapping.md.
 */
import { ApiError } from "@/server/http";
import { DECIMAL_MAX_PRECISION, decimalFits, formatDecimalType, parseDecimalType, type DecimalSpec } from "@/lib/decimal-type";

export const TEXT_TYPE = "NVARCHAR(MAX)";

export class SourceValueError extends ApiError {
  constructor(code: string, message: string) {
    super(422, code, message);
  }
}

export type ConvertContext = {
  /** nome da coluna (so para a mensagem de erro; nunca inclui o valor) */
  column?: string;
  /** coluna legada (era DECIMAL(18,4) de float/numeric sem escala): escala excedente e arredondada, como sempre foi; NaN/estouro falham */
  legacyRound?: boolean;
  /** chamado quando uma coluna legada arredondou um ponto flutuante com mais de 15 digitos significativos (para registrar o aviso) */
  onRounded?: () => void;
};

const where = (ctx?: ConvertContext) => (ctx?.column ? ` na coluna "${ctx.column}"` : "");

// ── Numericos ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Expande notacao cientifica ("1.5e-7", "2e+21") para decimal posicional exato. */
export function expandExponent(s: string): string {
  const m = /^([-+]?)(\d*)(?:\.(\d*))?[eE]([-+]?\d+)$/.exec(s);
  if (!m) return s;
  const sign = m[1] === "-" ? "-" : "";
  const int = m[2] ?? "", frac = m[3] ?? "";
  const exp = Number(m[4]);
  let digits = int + frac;
  let point = int.length + exp;
  if (point <= 0) { digits = "0".repeat(1 - point) + digits; point = 1; }
  else if (point > digits.length) digits = digits + "0".repeat(point - digits.length);
  const ip = digits.slice(0, point).replace(/^0+(?=\d)/, "") || "0";
  const fp = digits.slice(point).replace(/0+$/, "");
  return `${sign}${ip}${fp ? "." + fp : ""}`;
}

/** Texto decimal exato (sem expoente, sem sinal '+') de um valor de driver; NaN/Infinity/ilegivel falham. */
export function exactDecimalString(value: unknown, ctx?: ConvertContext): string {
  let s: string;
  if (typeof value === "bigint") s = value.toString();
  else if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new SourceValueError("SOURCE_VALUE_NOT_FINITE", `Valor numerico nao finito (NaN/Infinity)${where(ctx)}: a coluna e DECIMAL e nao pode guardar esse valor. Converta na consulta (CASE/NULLIF) ou use uma fonte com a coluna como texto.`);
    s = expandExponent(String(value));
    // O driver (SQL Server) entrega decimal como double: mais de 15 digitos significativos nao sao verificaveis.
    const digits = s.replace(/^[-+]?0*\.?0*/, "").replace(".", "").replace(/0+$/, "").length;
    if (digits > 15 && ctx?.legacyRound) ctx.onRounded?.();
    if (digits > 15 && !ctx?.legacyRound) throw new SourceValueError("SOURCE_VALUE_PRECISION_LOSS", `Numerico com mais de 15 digitos significativos recebido como ponto flutuante${where(ctx)}: o driver da origem nao garante o valor exato. Converta a coluna para texto na consulta da fonte (CAST ... AS VARCHAR).`);
  } else if (typeof value === "string") s = value.trim();
  else throw new SourceValueError("SOURCE_VALUE_INVALID", `Valor numerico invalido${where(ctx)}`);
  if (/^[-+]?(nan|inf(inity)?)$/i.test(s)) throw new SourceValueError("SOURCE_VALUE_NOT_FINITE", `Valor numerico nao finito (NaN/Infinity)${where(ctx)}: a coluna e DECIMAL e nao pode guardar esse valor. Converta na consulta ou trate a coluna como texto.`);
  s = expandExponent(s.replace(/^\+/, ""));
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) throw new SourceValueError("SOURCE_VALUE_INVALID", `Valor numerico invalido${where(ctx)}`);
  return s.replace(/^(-?)0+(?=\d)/, "$1").replace(/^(-?)\./, "$10.").replace(/\.$/, "");
}

/** Arredonda (metade para longe do zero) um decimal em texto para `scale` casas, sem passar por Number. */
export function roundDecimalString(s: string, scale: number): string {
  const neg = s.startsWith("-");
  const [ip, fp = ""] = s.replace(/^-/, "").split(".");
  if (fp.length <= scale) return s;
  const keep = fp.slice(0, scale);
  const up = fp.charCodeAt(scale) >= 53; // '5'
  let digits = BigInt((ip ?? "0") + keep);
  if (up) digits += 1n;
  let str = digits.toString().padStart(scale + 1, "0");
  const out = scale > 0 ? `${str.slice(0, str.length - scale)}.${str.slice(str.length - scale)}` : str;
  return (neg && /[1-9]/.test(out) ? "-" : "") + out;
}

function convertDecimal(value: unknown, type: string, ctx?: ConvertContext): string {
  const spec: DecimalSpec = parseDecimalType(type) ?? { precision: 18, scale: 4 };
  let s = exactDecimalString(value, ctx);
  if (!decimalFits(s, spec)) {
    if (ctx?.legacyRound) s = roundDecimalString(s, spec.scale);
    if (!decimalFits(s, spec)) {
      throw new SourceValueError("SOURCE_VALUE_OVERFLOW", `Valor numerico fora da faixa de ${formatDecimalType(spec)}${where(ctx)}: gravar arredondaria ou perderia o valor. Amplie o tipo da coluna (recarregue a fonte) ou converta na consulta.`);
    }
  }
  return s;
}

// ── Datas ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const TS_RE = /^(\d{4,6})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?)?\s*(Z|[+-]\d{2}(?::?\d{2}(?::?\d{2})?)?)?$/;
const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export type Temporal = { y: number; mo: number; d: number; h: number; mi: number; s: number; frac: string };

/**
 * Le "YYYY-MM-DD[ T]HH:MM:SS[.ffffff][offset]" (texto cru do Postgres, ISO do Date do driver, marca d'agua antiga com Z)
 * e devolve os componentes em UTC. Fracao preservada (6 digitos, microssegundos). Infinity/BC/anos fora de 1..9999 -> null.
 */
export function parseTemporal(raw: string): Temporal | null {
  const m = TS_RE.exec(raw.trim());
  if (!m) return null;
  const y = Number(m[1]);
  if (y < 1 || y > 9999) return null;
  let t: Temporal = { y, mo: Number(m[2]), d: Number(m[3]), h: Number(m[4] ?? 0), mi: Number(m[5] ?? 0), s: Number(m[6] ?? 0), frac: (m[7] ?? "").slice(0, 6).padEnd(6, "0") };
  if (t.mo < 1 || t.mo > 12 || t.d < 1 || t.d > 31 || t.h > 24 || t.mi > 59 || t.s > 60) return null;
  const off = m[8];
  if (off && off !== "Z") {
    const sign = off.startsWith("-") ? -1 : 1;
    const p = off.slice(1).replace(/:/g, "");
    const secs = Number(p.slice(0, 2)) * 3600 + Number(p.slice(2, 4) || 0) * 60 + Number(p.slice(4, 6) || 0);
    if (secs !== 0) {
      const ms = Date.UTC(t.y, t.mo - 1, t.d, t.h, t.mi, t.s) - sign * secs * 1000;
      const u = new Date(ms);
      if (u.getUTCFullYear() < 1 || u.getUTCFullYear() > 9999) return null;
      t = { y: u.getUTCFullYear(), mo: u.getUTCMonth() + 1, d: u.getUTCDate(), h: u.getUTCHours(), mi: u.getUTCMinutes(), s: u.getUTCSeconds(), frac: t.frac };
    }
  }
  return t;
}

export const formatTimestamp = (t: Temporal) => `${pad(t.y, 4)}-${pad(t.mo)}-${pad(t.d)} ${pad(t.h)}:${pad(t.mi)}:${pad(t.s)}.${t.frac}`;
export const formatDate = (t: Temporal) => `${pad(t.y, 4)}-${pad(t.mo)}-${pad(t.d)}`;

/** Timestamp canonico "YYYY-MM-DD HH:MM:SS.ffffff" em UTC, independente do fuso do processo; falha (nunca NULL) se nao representavel. */
export function normalizeTimestamp(value: unknown, ctx?: ConvertContext): string {
  const raw = value instanceof Date ? (Number.isNaN(value.getTime()) ? "" : value.toISOString()) : String(value);
  const t = parseTemporal(raw);
  if (!t) throw new SourceValueError("SOURCE_VALUE_UNREPRESENTABLE", `Data/hora nao representavel (infinity, BC, fora de 0001-9999 ou formato desconhecido)${where(ctx)}. Filtre ou converta na consulta da fonte, ou trate a coluna como texto.`);
  return formatTimestamp(t);
}

export function normalizeDate(value: unknown, ctx?: ConvertContext): string {
  const raw = value instanceof Date ? (Number.isNaN(value.getTime()) ? "" : value.toISOString()) : String(value);
  const t = parseTemporal(raw);
  if (!t) throw new SourceValueError("SOURCE_VALUE_UNREPRESENTABLE", `Data nao representavel (infinity, BC, fora de 0001-9999 ou formato desconhecido)${where(ctx)}. Filtre ou converta na consulta da fonte, ou trate a coluna como texto.`);
  return formatDate(t);
}

// ── Conversao geral ──────────────────────────────────────────────────────────────────────────────────────────────────

export function convertSourceValue(value: unknown, type: string, ctx?: ConvertContext): string | null {
  if (value == null) return null;
  if (type === "BIGINT") {
    const s = typeof value === "bigint" ? value.toString() : typeof value === "number" && !Number.isSafeInteger(value) ? "" : String(value).trim();
    if (!/^-?\d+$/.test(s)) throw new SourceValueError("SOURCE_VALUE_INVALID", `Valor inteiro invalido${where(ctx)} (nao e um inteiro exato)`);
    return s;
  }
  if (type.startsWith("DECIMAL")) return convertDecimal(value, type, ctx);
  if (type === "DATE") return normalizeDate(value, ctx);
  if (type === "DATETIME2") return normalizeTimestamp(value, ctx);
  if (type === "TIME") return String(value).trim().replace(/\s*[+-]\d{2}(?::?\d{2}(?::?\d{2})?)?$/, ""); // TIME nao guarda deslocamento (timetz legado)
  let s: string;
  if (typeof value === "string") s = value;
  else if (Buffer.isBuffer(value)) s = "\\x" + value.toString("hex"); // bytea/varbinary: hexadecimal, sem perda
  else if (value instanceof Date) s = Number.isNaN(value.getTime()) ? "" : value.toISOString();
  else if (typeof value === "object") s = JSON.stringify(value);
  else s = String(value);
  if (s.includes(" ")) throw new SourceValueError("SOURCE_VALUE_NUL_BYTE", `Texto com byte NUL (0x00)${where(ctx)}: o armazenamento nao aceita e remover alteraria o valor. Limpe na origem ou use REPLACE(col, CHAR(0), '') na consulta da fonte.`);
  return s;
}

// ── Mapeamento de tipos ──────────────────────────────────────────────────────────────────────────────────────────────

/** numeric(p,s) -> DECIMAL(p,s) exato; sem precisao declarada ou p > 38 -> texto (nunca arredonda). */
export function decimalOrText(precision: number | null | undefined, scale: number | null | undefined): { sqlType: string; lossyNumeric: boolean } {
  if (precision == null || scale == null || precision < 1 || precision > DECIMAL_MAX_PRECISION || scale < 0 || scale > precision) {
    return { sqlType: TEXT_TYPE, lossyNumeric: true };
  }
  return { sqlType: formatDecimalType({ precision, scale }), lossyNumeric: false };
}

/** typmod do Postgres (numeric(p,s) = ((p<<16)|s)+4); -1 = sem restricao. */
export function numericFromTypmod(typmod: number | null | undefined): { precision: number | null; scale: number | null } {
  if (typmod == null || typmod < 4) return { precision: null, scale: null };
  const t = typmod - 4;
  return { precision: (t >> 16) & 0xffff, scale: t & 0xffff };
}

export type CatalogColumn = { sqlName: string; sqlType: string };
export type ResolvedColumn = { originalName: string; sqlName: string; sqlType: string; nullable: boolean; lossyNumeric?: boolean; pgType?: string; legacyRound?: boolean };

export type SchemaComparison = { columns: ResolvedColumn[]; changed: boolean; changes: string[] };

/**
 * Compara as colunas atuais da origem com o catalogo gravado no ultimo carregamento (FON-11/FON-15) e preserva o tipo
 * legado quando ele comporta o novo (nao forca recarga de fontes existentes so por causa do mapeamento mais fiel):
 *  - DECIMAL legado que comporta o DECIMAL(p,s) novo -> mantem o legado;
 *  - DECIMAL legado onde a origem agora e "numerico sem escala definida"/float (virou texto) -> mantem o legado, com
 *    arredondamento de escala como sempre foi, mas NaN/estouro falham (nao viram NULL).
 * Diferenca restante (coluna nova, sumida/renomeada, tipo diferente) = `changed`: quem chama recarrega a tabela inteira.
 */
export function compareWithCatalog<T extends ResolvedColumn>(current: T[], catalog: CatalogColumn[] | undefined | null): { columns: T[]; changed: boolean; changes: string[] } {
  if (!catalog?.length) return { columns: current, changed: false, changes: [] };
  const changes: string[] = [];
  const byName = new Map(catalog.map(c => [c.sqlName, c.sqlType]));
  const seen = new Set<string>();
  const columns = current.map((col): T => {
    seen.add(col.sqlName);
    const old = byName.get(col.sqlName);
    if (old === undefined) { changes.push(`coluna nova "${col.sqlName}"`); return col; }
    if (old === col.sqlType) return col;
    const oldSpec = parseDecimalType(old);
    const newSpec = parseDecimalType(col.sqlType);
    if (oldSpec && newSpec && newSpec.scale <= oldSpec.scale && newSpec.precision - newSpec.scale <= oldSpec.precision - oldSpec.scale) return { ...col, sqlType: old };
    // Diferenca so de MAPEAMENTO (money = DECIMAL(19,4) x legado (18,4); numeric(20,6) x (18,4)): a tabela ja guarda os dados no tipo
    // legado, entao NAO ha mudanca estrutural e nao se recarrega (nem se congela fonte com janela). Mantem o tipo e a regra de
    // arredondamento legados; valor que estoura a faixa continua falhando alto (SOURCE_VALUE_OVERFLOW), nunca vira NULL.
    if (oldSpec && newSpec) return { ...col, sqlType: old, ...(newSpec.scale > oldSpec.scale ? { legacyRound: true } : {}) };
    // timetz: o legado gravava TIME (sem o deslocamento); o mapeamento novo e texto. Mesmo tipo de familia -> mantem o legado.
    if (old === "TIME" && col.sqlType === TEXT_TYPE && /^timetz$|time with time zone/i.test(col.pgType ?? "")) return { ...col, sqlType: old };
    if (oldSpec && col.lossyNumeric && col.sqlType === TEXT_TYPE) return { ...col, sqlType: old, legacyRound: true };
    changes.push(`tipo de "${col.sqlName}" mudou de ${old} para ${col.sqlType}`);
    return col;
  });
  for (const c of catalog) if (!seen.has(c.sqlName)) changes.push(`coluna "${c.sqlName}" nao existe mais na origem (removida ou renomeada)`);
  return { columns, changed: changes.length > 0, changes };
}
