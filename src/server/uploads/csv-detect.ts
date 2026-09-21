/**
 * Detecção de encoding e dialeto de CSV + leitura estrita de registros (TIP-03/04/07/17/18, docs/estudo-confiabilidade-dados.md).
 *
 * Princípios:
 *  - o encoding é decidido olhando o arquivo INTEIRO (decoder UTF-8 fatal em streaming), não 64 KB; UTF-16 por BOM ou por padrão de NULs;
 *  - nunca decodificar com caractere de substituição (U+FFFD) em silêncio: byte inválido = erro;
 *  - o separador é escolhido por consistência de colunas nas primeiras linhas; empate = erro (não adivinha);
 *  - `sep=;` na primeira linha (Excel) é lido e pulado; um preâmbulo que quebra o cabeçalho é erro;
 *  - registro com MAIS campos que o cabeçalho é erro nomeando a linha (campos extras vazios são aceitos); com menos, é completado com NULL;
 *  - fim de linha misto (\r\n, \n, \r no mesmo arquivo) nunca funde registros.
 */
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { Transform } from "node:stream";
import { parse as parseCsvSync } from "csv-parse/sync";
import { parse } from "csv-parse";
import iconv from "iconv-lite";

export type CsvEncoding = "utf8" | "utf16le" | "utf16be" | "win1252";
export type FileHints = {
  encoding: CsvEncoding;
  separator: string;
  /** primeira linha era `sep=X` (já consumida: o cabeçalho é a linha seguinte) */
  sepDirective: boolean;
  headerFields: string[];
  /** há mais de um estilo de fim de linha no arquivo (o caminho rápido do DuckDB não é usado) */
  mixedEol: boolean;
};

export const SEPARATOR_CANDIDATES = [";", ",", "\t", "|"] as const;
const SAMPLE_BYTES = 65536;
const RECORD_DELIMITERS = ["\r\n", "\n", "\r"];

export class CsvFormatError extends Error {
  constructor(message: string) { super(message); this.name = "CsvFormatError"; }
}

// ─── Decoder estrito (nunca U+FFFD em silêncio) ──────────────────────────────

type StrictDecoder = { write(chunk: Buffer): string; end(): string };

function strictDecoder(encoding: CsvEncoding): StrictDecoder {
  if (encoding === "win1252") {
    const dec = iconv.getDecoder("win1252");
    const check = (s: string) => {
      if (s.includes("�")) throw new CsvFormatError("O arquivo tem byte inválido para Windows-1252 (não seria possível ler o valor sem trocá-lo por \"�\"). Reexporte o arquivo em UTF-8.");
      return s;
    };
    return { write: (c) => check(dec.write(c) ?? ""), end: () => check(dec.end() ?? "") };
  }
  const label = encoding === "utf8" ? "utf-8" : encoding === "utf16le" ? "utf-16le" : "utf-16be";
  // ignoreBOM=false: o BOM inicial é consumido
  const dec = new TextDecoder(label, { fatal: true });
  const wrap = (fn: () => string) => {
    try { return fn(); } catch { throw new CsvFormatError(`O arquivo não é ${encoding === "utf8" ? "UTF-8" : "UTF-16"} válido (byte inesperado); recusado para não trocar caracteres em silêncio.`); }
  };
  return { write: (c) => wrap(() => dec.decode(c, { stream: true })), end: () => wrap(() => dec.decode()) };
}

/** Transform bytes → texto UTF-8, estrito. Usado no import (csv-parse) e na transcodificação para o DuckDB. */
export function strictDecodeStream(encoding: CsvEncoding | string): Transform {
  const enc = normalizeEncoding(encoding);
  const dec = strictDecoder(enc);
  return new Transform({
    transform(chunk: Buffer, _e, cb) { try { cb(null, dec.write(chunk)); } catch (e) { cb(e as Error); } },
    flush(cb) { try { cb(null, dec.end()); } catch (e) { cb(e as Error); } },
  });
}

export function normalizeEncoding(e: string | undefined | null): CsvEncoding {
  const v = (e ?? "utf8").toLowerCase().replace(/[-_]/g, "");
  if (v === "utf8") return "utf8";
  if (v === "utf16le" || v === "utf16") return "utf16le";
  if (v === "utf16be") return "utf16be";
  return "win1252"; // win1252, latin1, iso88591, cp1252...
}

// ─── Estilos de fim de linha ─────────────────────────────────────────────────

class EolCounter {
  crlf = 0; lf = 0; cr = 0; private carryCr = false;
  feed(s: string) {
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      if (this.carryCr) { this.carryCr = false; if (ch === 10) { this.crlf++; continue; } this.cr++; }
      if (ch === 13) this.carryCr = true; else if (ch === 10) this.lf++;
    }
  }
  end() { if (this.carryCr) { this.cr++; this.carryCr = false; } }
  get mixed() { return [this.crlf, this.lf, this.cr].filter((n) => n > 0).length > 1; }
}

// ─── Encoding: arquivo inteiro ───────────────────────────────────────────────

async function bomEncoding(path: string): Promise<{ encoding: CsvEncoding | null; sample: Buffer }> {
  const h = await open(path, "r");
  try {
    const buf = Buffer.alloc(SAMPLE_BYTES);
    const { bytesRead } = await h.read(buf, 0, buf.length, 0);
    const sample = buf.subarray(0, bytesRead);
    if (sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) return { encoding: "utf8", sample };
    if (sample[0] === 0xff && sample[1] === 0xfe) return { encoding: "utf16le", sample };
    if (sample[0] === 0xfe && sample[1] === 0xff) return { encoding: "utf16be", sample };
    // UTF-16 sem BOM: texto ASCII-ish tem NUL em toda segunda posição
    if (sample.length >= 8) {
      let even = 0, odd = 0; const n = Math.min(sample.length, 4096) & ~1;
      for (let i = 0; i < n; i += 2) { if (sample[i] === 0) even++; if (sample[i + 1] === 0) odd++; }
      if (odd > n / 2 * 0.3 && even === 0) return { encoding: "utf16le", sample };
      if (even > n / 2 * 0.3 && odd === 0) return { encoding: "utf16be", sample };
    }
    return { encoding: null, sample };
  } finally { await h.close(); }
}

/** Decodifica o arquivo inteiro (streaming) com o decoder estrito; devolve o começo do texto e os estilos de fim de linha. */
async function scanWhole(path: string, encoding: CsvEncoding): Promise<{ head: string; mixedEol: boolean }> {
  const dec = strictDecoder(encoding);
  const eol = new EolCounter();
  let head = "";
  for await (const chunk of createReadStream(path)) {
    const text = dec.write(chunk as Buffer);
    eol.feed(text);
    if (head.length < SAMPLE_BYTES) head += text;
  }
  const tail = dec.end();
  eol.feed(tail); eol.end();
  if (head.length < SAMPLE_BYTES) head += tail;
  return { head, mixedEol: eol.mixed };
}

// ─── Aspa nao fechada ────────────────────────────────────────────────────────

/**
 * Linha (1-based) em que abriu uma aspa que NUNCA foi fechada ate o fim do arquivo, ou null. Uma aspa de abertura sem fechamento faz o
 * resto do arquivo virar UM valor so: o DuckDB nao acusa erro (devolve poucas linhas, com o resto engolido) e o import publicaria a tabela
 * quase vazia. Regra RFC 4180 (a mesma do csv-parse com relax_quotes): aspa so abre no INICIO de um campo; `""` dentro de aspas e uma aspa literal.
 */
export function firstUnclosedQuoteLine(text: string, separator: string, st: QuoteScan = newQuoteScan()): number | null {
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (st.cr) { st.cr = false; if (c === "\n") { st.line++; if (!st.inQuote || st.pendingQ) { /* fim de registro */ } continue; } st.line++; }
    if (st.inQuote) {
      if (st.pendingQ) {
        if (c === '"') { st.pendingQ = false; continue; }   // "" = aspa literal
        st.inQuote = false; st.pendingQ = false;             // a aspa anterior fechou o campo; `c` e processado abaixo, fora das aspas
      } else {
        if (c === '"') st.pendingQ = true;
        else if (c === "\n") st.line++;
        else if (c === "\r") st.cr = true;
        continue;
      }
    }
    if (c === "\n") { st.line++; st.fieldStart = true; }
    else if (c === "\r") { st.cr = true; st.fieldStart = true; }
    else if (c === separator) st.fieldStart = true;
    else if (c === '"' && st.fieldStart) { st.inQuote = true; st.openLine = st.line; st.fieldStart = false; }
    else st.fieldStart = false;
  }
  return st.inQuote && !st.pendingQ ? st.openLine : null;
}
export type QuoteScan = { inQuote: boolean; pendingQ: boolean; fieldStart: boolean; cr: boolean; line: number; openLine: number };
export const newQuoteScan = (): QuoteScan => ({ inQuote: false, pendingQ: false, fieldStart: true, cr: false, line: 1, openLine: 0 });

async function assertQuotesClosed(path: string, encoding: CsvEncoding, separator: string): Promise<void> {
  const dec = strictDecoder(encoding);
  const st = newQuoteScan();
  for await (const chunk of createReadStream(path)) firstUnclosedQuoteLine(dec.write(chunk as Buffer), separator, st);
  firstUnclosedQuoteLine(dec.end(), separator, st);
  if (st.inQuote && !st.pendingQ) throw unclosedQuoteError(st.openLine);
}

export function unclosedQuoteError(line: number): CsvFormatError {
  return new CsvFormatError(`As aspas abertas na linha ${line} nunca foram fechadas: o resto do arquivo seria lido como um único valor e as linhas seguintes se perderiam. Feche as aspas dessa linha (ou escape-as com "") e envie de novo.`);
}

// ─── Dialeto ─────────────────────────────────────────────────────────────────

type Score = { sep: string; hdr: number; ratio: number; head: string[] };

function scoreSeparator(text: string, sep: string): Score {
  let recs: string[][] = [];
  try {
    recs = parseCsvSync(text, { delimiter: sep, relax_column_count: true, relax_quotes: true, skip_empty_lines: true, record_delimiter: RECORD_DELIMITERS, to: 100 }) as string[][];
  } catch { return { sep, hdr: 0, ratio: 0, head: [] }; }
  // número de campos DOMINANTE (não o da 1ª linha): um título acima do cabeçalho não pode esconder o separador real
  const freq = new Map<number, number>();
  for (const r of recs) freq.set(r.length, (freq.get(r.length) ?? 0) + 1);
  const [dominant, n] = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0] ?? [0, 0];
  if (dominant < 2) return { sep, hdr: dominant, ratio: 0, head: recs[0] ?? [] };
  return { sep, hdr: dominant, ratio: n / recs.length, head: recs[0]! };
}

function pickSeparator(text: string): { sep: string; head: string[] } {
  const scores = SEPARATOR_CANDIDATES.map((c) => scoreSeparator(text, c)).filter((s) => s.hdr >= 2);
  if (!scores.length) return { sep: ",", head: parseFirst(text, ",") }; // uma única coluna
  scores.sort((a, b) => b.ratio - a.ratio || b.hdr - a.hdr);
  const best = scores[0]!;
  const tied = scores.filter((s) => s.ratio === best.ratio && s.hdr === best.hdr);
  if (tied.length > 1) {
    throw new CsvFormatError(`Delimitador ambíguo: ${tied.map((t) => JSON.stringify(t.sep)).join(" e ")} explicam igualmente bem as primeiras linhas. Padronize o arquivo (ou use a linha "sep=;" no início) para o Catworld não adivinhar.`);
  }
  return { sep: best.sep, head: best.head };
}

function parseFirst(text: string, sep: string): string[] {
  try {
    return (parseCsvSync(text, { delimiter: sep, relax_column_count: true, relax_quotes: true, skip_empty_lines: true, record_delimiter: RECORD_DELIMITERS, to: 1 }) as string[][])[0] ?? [];
  } catch { return []; }
}

/** Preâmbulo (título, linha de fonte) acima do cabeçalho: as linhas seguintes têm mais campos que a primeira. */
function assertHeaderIsFirstRecord(text: string, sep: string, header: string[]) {
  let recs: string[][] = [];
  try { recs = parseCsvSync(text, { delimiter: sep, relax_column_count: true, relax_quotes: true, skip_empty_lines: true, record_delimiter: RECORD_DELIMITERS, to: 50 }) as string[][]; } catch { return; }
  const body = recs.slice(1);
  if (body.length < 2) return;
  const freq = new Map<number, number>();
  for (const r of body) freq.set(r.length, (freq.get(r.length) ?? 0) + 1);
  const [dominant, n] = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]!;
  if (dominant > header.length && n >= Math.ceil(body.length * 0.6)) {
    throw new CsvFormatError(`A primeira linha do arquivo tem ${header.length} campo(s) mas as linhas seguintes têm ${dominant}: parece um título/preâmbulo acima do cabeçalho. Remova as linhas antes do cabeçalho para o Catworld não tratar dados como cabeçalho.`);
  }
}

const cache = new Map<string, FileHints>();

export async function detectFileHints(path: string): Promise<FileHints> {
  const st = await stat(path);
  const key = `${path}|${st.size}|${st.mtimeMs}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const { encoding: bom, sample } = await bomEncoding(path);
  let encoding: CsvEncoding;
  let scan: { head: string; mixedEol: boolean };
  if (bom) { encoding = bom; scan = await scanWhole(path, encoding); }
  else {
    try { encoding = "utf8"; scan = await scanWhole(path, "utf8"); }
    catch (e) {
      if (!(e instanceof CsvFormatError)) throw e;
      encoding = "win1252"; scan = await scanWhole(path, "win1252");
    }
  }
  void sample;

  let head = scan.head.replace(/^﻿/, "");
  // corta na última quebra de linha quando o arquivo é maior que a amostra (não analisar um registro pela metade)
  if (st.size > SAMPLE_BYTES) { const cut = Math.max(head.lastIndexOf("\n"), head.lastIndexOf("\r")); if (cut > 0) head = head.slice(0, cut + 1); }

  let separator: string, headerFields: string[], sepDirective = false;
  const dir = /^sep=(.)(?:\r\n|\n|\r)/i.exec(head);
  if (dir && (SEPARATOR_CANDIDATES as readonly string[]).includes(dir[1]!)) {
    sepDirective = true;
    separator = dir[1]!;
    head = head.slice(dir[0].length);
    headerFields = parseFirst(head, separator);
  } else {
    const p = pickSeparator(head);
    separator = p.sep; headerFields = p.head;
  }
  assertHeaderIsFirstRecord(head, separator, headerFields);
  await assertQuotesClosed(path, encoding, separator); // aspa sem fechamento engole o resto do arquivo: recusa nomeando a linha

  const hints: FileHints = { encoding, separator, sepDirective, headerFields, mixedEol: scan.mixedEol };
  cache.set(key, hints);
  if (cache.size > 50) cache.delete(cache.keys().next().value!);
  return hints;
}

// ─── Registros ───────────────────────────────────────────────────────────────

/**
 * Registros (string[]) de um stream de bytes: decodifica estrito, pula `sep=X`, e recusa registro com mais campos que o cabeçalho
 * (nomeando a linha). Campos extras vazios (vírgula sobrando no fim) são aceitos e descartados. O 1º registro devolvido é o cabeçalho.
 */
export async function* csvRecords(source: NodeJS.ReadableStream, encoding: string, separator: string): AsyncGenerator<string[]> {
  const parser = parse({ delimiter: separator, bom: true, relax_column_count: true, relax_quotes: true, skip_empty_lines: true, record_delimiter: RECORD_DELIMITERS, info: true });
  const decoded = source.pipe(strictDecodeStream(encoding));
  // propaga erro do decoder para o iterador (pipe não o faz)
  decoded.on("error", (e) => parser.destroy(e));
  source.on?.("error", (e) => parser.destroy(e as Error));
  decoded.pipe(parser);
  let first = true, headerLen = 0;
  // csv-parse acusa "Quote Not Closed" em ingles ao fim do stream: traduz e nomeia a linha (fontes por stream nao passam pelo detectFileHints)
  const iter = (async function* () {
    try { yield* parser as AsyncIterable<{ record: string[]; info: { lines: number } }>; }
    catch (e) {
      const m = /CSV_QUOTE_NOT_CLOSED/.test(String((e as { code?: string }).code)) ? /line (\d+)/.exec((e as Error).message) : null;
      if (m) throw unclosedQuoteError(Number(m[1]));
      throw e;
    }
  })();
  for await (const item of iter) {
    const row = item.record;
    if (first) {
      first = false;
      if (/^sep=.$/i.test(row.join(separator))) { first = true; continue; } // linha "sep=;" do Excel
      headerLen = row.length;
      yield row;
      continue;
    }
    if (row.length > headerLen) {
      const extra = row.slice(headerLen);
      if (extra.some((v) => v !== "")) {
        throw new CsvFormatError(`Linha ${item.info.lines} do arquivo tem ${row.length} campos mas o cabeçalho tem ${headerLen}: os valores extras seriam perdidos. Corrija a linha (aspas ou separador no meio de um valor?) e envie de novo.`);
      }
      yield row.slice(0, headerLen);
      continue;
    }
    yield row;
  }
}
