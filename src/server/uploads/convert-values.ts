/**
 * Conversão de valor de arquivo → valor físico (Postgres / SQL Server via TDS). Funções puras, sem I/O.
 *
 * Contrato de fidelidade (docs/estudo-confiabilidade-dados.md, TIP-01/06/09/11):
 *  - um valor NÃO vazio que não converte é ERRO (lança, com coluna e valor), nunca NULL;
 *  - decimais nunca passam por Number/parseFloat no caminho Postgres: string canônica validada por `decimalFits`;
 *  - vazio (só espaços) continua virando NULL (regra existente de chaves/importação, ver relatório).
 */
import { parseDecimalType, decimalFits, DECIMAL_LEGACY, type DecimalSpec } from "@/lib/decimal-type";
import { canonicalDecimal, type DecSep } from "./decimal-format";
import { normalizeDateLike, type DateOrder } from "./date-normalize";

export type ConvertColumn = { sqlName?: string; sqlType: string; decimalSep?: DecSep | null; dateOrder?: DateOrder | null; /** dígitos significativos necessários (do arquivo inteiro); ausente em mapeamentos antigos */ decimalDigits?: number | null };

export class ValueConversionError extends Error {
  /** Deterministico: repetir o job nao muda o resultado (o worker nao gasta tentativas). */
  readonly nonRetryable = true as const;
  constructor(column: ConvertColumn, value: string, why: string) {
    super(`Valor "${value.length > 60 ? value.slice(0, 60) + "…" : value}" não cabe no tipo ${column.sqlType}${column.sqlName ? ` da coluna ${column.sqlName}` : ""}: ${why}. O import foi interrompido para não gravar dado diferente do arquivo.`);
    this.name = "ValueConversionError";
  }
}

const BIGINT_MIN = -9223372036854775808n, BIGINT_MAX = 9223372036854775807n;

function decimalOrThrow(s: string, col: ConvertColumn): { canon: string; spec: DecimalSpec } {
  const spec = parseDecimalType(col.sqlType) ?? DECIMAL_LEGACY;
  const canon = canonicalDecimal(s, col.decimalSep);
  if (canon === null) throw new ValueConversionError(col, s, "não é um número decimal válido");
  if (!decimalFits(canon, spec)) throw new ValueConversionError(col, s, `excede a precisão/escala DECIMAL(${spec.precision},${spec.scale}) (seria arredondado ou truncado)`);
  return { canon, spec };
}

function bigintOrThrow(s: string, col: ConvertColumn): bigint {
  if (!/^-?\d+$/.test(s)) throw new ValueConversionError(col, s, "não é um inteiro");
  const b = BigInt(s);
  if (b < BIGINT_MIN || b > BIGINT_MAX) throw new ValueConversionError(col, s, "fora do intervalo de 64 bits");
  return b;
}

function timeOrThrow(s: string, col: ConvertColumn): { h: number; m: number; s: number; frac: string } {
  const mt = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/.exec(s);
  if (!mt) throw new ValueConversionError(col, s, "não é uma hora");
  const h = Number(mt[1]), m = Number(mt[2]), se = Number(mt[3] ?? 0);
  if (h > 23 || m > 59 || se > 59) throw new ValueConversionError(col, s, "hora fora da faixa 00:00:00-23:59:59");
  return { h, m, s: se, frac: mt[4] ?? "" };
}

/** Postgres: string aceita por `unnest($n::text[])::<tipo>` (o banco valida de novo; aqui já falha com mensagem útil). null só para vazio. */
export function convertForPg(v: unknown, col: ConvertColumn | string): string | null {
  const c: ConvertColumn = typeof col === "string" ? { sqlType: col } : col;
  const sqlType = c.sqlType;
  const s = v == null ? "" : String(v).trim();
  if (!s) return null;

  if (sqlType === "BIGINT") return bigintOrThrow(s, c).toString();
  if (sqlType.startsWith("DECIMAL")) return decimalOrThrow(s, c).canon;
  if (sqlType === "DATE" || sqlType === "DATETIME2") {
    const d = normalizeDateLike(s, c.dateOrder);
    if (!d) throw new ValueConversionError(c, s, "data inválida, ambígua ou com fuso diferente de UTC");
    return d;
  }
  if (sqlType === "TIME") { timeOrThrow(s, c); return s; }
  // TEXT: só bytes NUL saem (o Postgres não os aceita em text). Um valor feito só de NUL ficaria vazio: erro, não NULL.
  const t = s.replace(/\x00/g, "");
  if (!t) throw new ValueConversionError(c, s.replace(/\x00/g, "\\0"), "valor só com bytes nulos");
  return t;
}

const TDS_MAX_DECIMAL_DIGITS = 15; // o driver (tedious) escreve DECIMAL via Number: acima de 15 dígitos significativos perderia exatidão

/**
 * DECIMAL com mais de 15 dígitos NÃO pode ir pelo bulk tipado (o driver passa por Number e arredondaria). Essas colunas entram na staging
 * como texto (NVARCHAR(64)) e são convertidas para DECIMAL(p,s) por um ALTER COLUMN depois da carga, exatas (visto contra SQL Server real).
 */
export function isWideDecimal(col: { sqlType: string; decimalDigits?: number | null }): boolean {
  // Só é "largo" quando o ARQUIVO precisa de mais de 15 dígitos: o piso DECIMAL(18,4) sozinho não muda o caminho (a maioria das colunas
  // cabe em 15 e continua no bulk tipado, sem o ALTER COLUMN extra). Mapeamento antigo (sem decimalDigits): comportamento anterior.
  return !!parseDecimalType(col.sqlType) && (col.decimalDigits ?? 0) > TDS_MAX_DECIMAL_DIGITS;
}

/**
 * SQL Server via TDS (bulk copy tipado). BIGINT sai como `bigint` (negativos e >2^53 exatos); datas são construídas em UTC
 * (o driver usa useUTC=true), sem passar pelo fuso do processo. DECIMAL(p>15,s) sai como texto exato (ver isWideDecimal).
 */
export function convertForTds(v: unknown, col: ConvertColumn | string): unknown {
  const c: ConvertColumn = typeof col === "string" ? { sqlType: col } : col;
  const sqlType = c.sqlType;
  const s = v == null ? "" : String(v).trim();
  if (!s) return null;
  if (sqlType === "BIGINT") return bigintOrThrow(s, c);
  if (sqlType.startsWith("DECIMAL")) {
    const { canon } = decimalOrThrow(s, c);
    if (isWideDecimal(c)) return canon; // texto exato: a coluna de staging é NVARCHAR(64) e vira DECIMAL(p,s) depois da carga
    const digits = canon.replace("-", "").replace(".", "").replace(/^0+(?=\d)/, "").length;
    if (digits > TDS_MAX_DECIMAL_DIGITS) throw new ValueConversionError(c, s, `tem ${digits} dígitos significativos e o driver TDS só grava DECIMAL com exatidão até ${TDS_MAX_DECIMAL_DIGITS}`);
    return Number(canon);
  }
  if (sqlType === "DATE" || sqlType === "DATETIME2") {
    const d = normalizeDateLike(s, c.dateOrder);
    if (!d) throw new ValueConversionError(c, s, "data inválida, ambígua ou com fuso diferente de UTC");
    const [datePart, rest = ""] = d.split(/[T ]/);
    const [timeRaw = "", frac = ""] = rest.split(".");
    const time = timeRaw || "00:00:00";
    if (/[1-9]/.test(frac.slice(3))) throw new ValueConversionError(c, s, "fração de segundo além de milissegundos (o driver TDS só grava até ms)");
    const [hh, mm, ss = "00"] = time.split(":");
    const ms = frac.slice(0, 3).padEnd(3, "0");
    const date = new Date(`${datePart}T${hh}:${mm}:${ss}.${ms}Z`);
    if (isNaN(date.getTime())) throw new ValueConversionError(c, s, "data inválida");
    return sqlType === "DATE" ? new Date(`${datePart}T00:00:00.000Z`) : date;
  }
  if (sqlType === "TIME") {
    // mssql sql.Time exige Date; construído em UTC porque o driver lê os campos UTC (useUTC=true)
    const t = timeOrThrow(s, c);
    if (/[1-9]/.test(t.frac.slice(3))) throw new ValueConversionError(c, s, "fração de segundo além de milissegundos");
    return new Date(Date.UTC(1970, 0, 1, t.h, t.m, t.s, Number(t.frac.slice(0, 3).padEnd(3, "0"))));
  }
  const t = s.replace(/\x00/g, ""); // NUL corrompe o stream BCP (erro 4815)
  if (!t) throw new ValueConversionError(c, s.replace(/\x00/g, "\\0"), "valor só com bytes nulos");
  return t;
}

/** Expressão T-SQL do fallback (staging NVARCHAR(MAX)): usa a convenção da coluna e o DECIMAL(p,s) real, em vez de (18,4) fixo. */
export function decimalTsqlExpr(value: string, col: ConvertColumn): string {
  const spec = parseDecimalType(col.sqlType) ?? DECIMAL_LEGACY;
  const cleaned = col.decimalSep === "," ? `REPLACE(REPLACE(${value},'.',''),',','.')`
    : col.decimalSep === "." ? `REPLACE(${value},',','')`
    : `CASE WHEN ${value} LIKE '%,%' THEN REPLACE(REPLACE(${value},'.',''),',','.') ELSE ${value} END`;
  return `TRY_CONVERT(DECIMAL(${spec.precision},${spec.scale}),${cleaned})`;
}
