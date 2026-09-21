/** Valores de resultado -> texto de CSV / celula de XLSX (bigint, decimal, Date, Buffer, objeto). */

function plain(value: unknown, iso: boolean): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : (iso ? value.toISOString() : String(value));
  if (typeof value === "bigint") return value.toString();
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return `0x${value.toString("hex")}`;
  if (typeof value === "object") return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  return String(value);
}

const NUMERIC_TEXT = /^[+-]?(\d+([.,]\d+)?|[.,]\d+)([eE][+-]?\d+)?$/;
/** Numero/telefone/moeda: so digitos, espacos, parenteses, ponto, virgula, `$`, `€` e hifen, com sinal opcional. */
const NUMBER_LIKE = /^[+-]?[\d\s().,$€-]+$/;
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Neutraliza injecao de formula (CSV injection / OWASP): texto que comeca com `=`, `+`, `-`, `@`, TAB ou CR e
 * interpretado como formula pelo Excel/LibreOffice. Prefixa uma aspa simples (o Excel a esconde e trata a celula como
 * texto). NAO sao tocados: numeros (`-5`, `1e3`), telefones (`+55 11 99999-9999`), moeda (`-$1,234.50`), `-`/`+` sozinhos,
 * `@usuario` e `-1 days`. Prefixados: `=`, TAB/CR, `@FUNCAO(`, e `+`/`-` seguidos de letra ou `(`.
 * ATENCAO: a linha-marcador `# RESULTADO TRUNCADO` (csvTruncationRow) e escrita SEM neutralizacao (comeca com `#`,
 * nao e formula); consumidores que interpretam `#` como comentario ou tipam a coluna pela ultima linha devem tratar essa linha.
 * So se aplica a valores de TEXTO (string); numero/bigint/Date vindos do banco nunca sao alterados.
 */
export function neutralizeFormula(value: unknown, text: string): string {
  if (typeof value !== "string" || text === "") return text;
  if (!FORMULA_START.test(text)) return text;
  const t = text.trim();
  if (NUMERIC_TEXT.test(t) || NUMBER_LIKE.test(t)) return text; // numero, telefone, moeda: dado, nao formula
  if (text[0] === "=" || text[0] === "\t" || text[0] === "\r") return `'${text}`;
  if (text[0] === "@") return /^@\s*[A-Za-z_][\w.]*\s*\(/.test(text) ? `'${text}` : text; // @usuario e menção, @SUM(...) e formula
  // + ou -: seguido de letra, "(" ou "@" e formula; o resto so se trouxer operador (| ! ( = + * /) depois do sinal
  if (t === "+" || t === "-") return text;
  if (/^[+-]\s*[A-Za-z_(@]/.test(text) || /[|!(=+*\/]/.test(text.slice(1))) return `'${text}`;
  return text;
}
export type CsvOptions = {
  /** Datas em ISO-8601 (padrao dos endpoints de exportacao). */
  iso?: boolean;
  /** Neutraliza formulas (padrao true). `false` = opt-out explicito. */
  formulaSafe?: boolean;
};

/** Campo CSV entre aspas. Aspas, quebras de linha e CR solto ficam DENTRO das aspas (RFC 4180). */
export function csvField(value: unknown, isoOrOpts: boolean | CsvOptions = false): string {
  const o: CsvOptions = typeof isoOrOpts === "boolean" ? { iso: isoOrOpts } : isoOrOpts;
  let text = plain(value, !!o.iso);
  if (o.formulaSafe !== false) text = neutralizeFormula(value, text);
  return `"${text.replaceAll('"', '""')}"`;
}

/** Campo CSV com aspas so quando preciso (separador, aspas, LF ou CR — inclusive CR solto — no texto). */
export function csvMinimalField(value: unknown, sep: string, o: CsvOptions = {}): string {
  let text = plain(value, !!o.iso);
  if (o.formulaSafe !== false) text = neutralizeFormula(value, text);
  return text.includes(sep) || text.includes('"') || text.includes("\n") || text.includes("\r") ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * Linha de aviso no fim do CSV truncado (uma linha de dados a mais, de proposito: um arquivo truncado nunca deve
 * passar por completo). `columnCount` mantem o numero de campos das demais linhas.
 */
export function csvTruncationRow(limit: number, columnCount: number, sep = ","): string {
  const msg = `# RESULTADO TRUNCADO em ${limit} linhas: ha mais linhas do que o exportado`;
  return [csvField(msg, { formulaSafe: false }), ...Array.from({ length: Math.max(0, columnCount - 1) }, () => '""')].join(sep);
}

/** Celula XLSX: numeros, booleanos e datas ficam nativos; bigint/objeto/Buffer viram texto. */
export function xlsxCell(value: unknown, kind?: string): string | number | boolean | Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    // BIGINT/DECIMAL chegam como texto (o JS nao os representa sem perda): numero so quando e EXATO, senao texto
    if (kind === "bigint" || kind === "decimal") {
      const n = exactNumber(value);
      return n === null ? value : n;
    }
    return value;
  }
  return plain(value, true);
}

/** Numero JS igual ao texto decimal, ou null se converter perderia digitos (mais de 15 digitos significativos, etc). */
export function exactNumber(text: string): number | null {
  const s = text.trim();
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return null;
  const [intPart, frac = ""] = s.replace(/^[+-]/, "").split(".");
  const digits = (intPart!.replace(/^0+/, "") + frac.replace(/0+$/, "")).length;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  if (frac.replace(/0+$/, "") === "") return Number.isSafeInteger(n) ? n : null;
  return digits <= 15 && Number(String(n)) === n && normalizeDecimal(String(n)) === normalizeDecimal(s) ? n : null;
}

function normalizeDecimal(s: string): string {
  const neg = s.startsWith("-");
  const [i = "0", f = ""] = s.replace(/^[+-]/, "").split(".");
  const ip = i.replace(/^0+(?=\d)/, "");
  const fp = f.replace(/0+$/, "");
  return `${neg ? "-" : ""}${ip}${fp ? "." + fp : ""}`;
}
