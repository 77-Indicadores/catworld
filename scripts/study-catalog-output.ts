/**
 * Estudo de Performance — Catálogo da pasta output
 * 
 * Mede para cada arquivo:
 * - nome, tamanho em bytes, linhas, colunas
 * - tempo de preview (inferência de schema)
 * - tempo de conversão simulada (sem upload/blob) para estimar o custo puro de parse+convert
 * - hash MD5 do conteúdo para detecção de duplicatas/invariantes
 * 
 * Output: JSON e CSV no console para análise.
 * 
 * Uso: npx tsx scripts/study-catalog-output.ts [--preview-only] [--full]
 *   --preview-only: apenas preview, sem simular conversão linha a linha
 *   --full: preview + conversão linha a linha (mais lento)
 */

import { createReadStream, createWriteStream, statSync, readdirSync, existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { resolve, basename, extname } from "node:path";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parse } from "csv-parse";
import iconv from "iconv-lite";
import ExcelJS from "exceljs";
import { normalizeDateLike } from "../src/server/uploads/date-normalize";
import { sqlIdentifier } from "../src/server/security/naming";

// ─── Env ──────────────────────────────────────────────
const envPath = resolve(".", ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const sep = t.indexOf("="); if (sep === -1) continue;
    const key = t.slice(0, sep).trim(); let val = t.slice(sep + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
}

const OUTPUT_DIR = process.env["STUDY_OUTPUT_DIR"] || resolve("C:\\Users\\TRABALHO\\Documents\\GitHub\\rp_automation_ftp_arquivos\\output");

// ─── Types ────────────────────────────────────────────
type ParsedColumn = { originalName: string; sqlName: string; sqlType: string; nullable: boolean };
type FileMetrics = {
  name: string;
  ext: string;
  sizeBytes: number;
  sizeMB: string;
  rows: number;
  cols: number;
  previewMs: number;
  convertMs: number | null;   // null se --preview-only
  convertRowsPerSec: number | null;
  fileHash: string;
  encoding: string;
  separator: string | null;
  colTypes: string;           // ex: "BIGINT x3, NVARCHAR x20, DATE x2..."
};

// ─── CSV Preview (simplificado do parser.ts) ──────────
async function detectFileHints(path: string): Promise<{ encoding: string; separator: string }> {
  const fd = await import("node:fs/promises");
  const handle = await fd.open(path, "r");
  const buffer = Buffer.alloc(65536);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
  await handle.close();
  const sample = buffer.subarray(0, bytesRead);

  let encoding: string;
  if (sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) {
    encoding = "utf8";
  } else {
    try { new TextDecoder("utf-8", { fatal: true }).decode(sample); encoding = "utf8"; }
    catch { encoding = "win1252"; }
  }

  const text = iconv.decode(sample, encoding);
  const candidates = [";", ",", "\t"];
  const separator = candidates
    .map(c => ({ c, score: text.split(/\r?\n/).slice(0, 10).reduce((n, l) => n + (l.split(c).length - 1), 0) }))
    .sort((a, b) => b.score - a.score)[0].c;

  return { encoding, separator };
}

function csvPipeStream(source: NodeJS.ReadableStream, encoding: string, separator: string): AsyncIterable<string[]> {
  return source
    .pipe(iconv.decodeStream(encoding))
    .pipe(parse({ delimiter: separator, bom: true, relax_column_count: true, relax_quotes: true, skip_empty_lines: true })) as AsyncIterable<string[]>;
}

// ─── Type Inference (simplificado, idêntica lógica do parser.ts) ───
const RE_INT = /^-?\d+$/;
const RE_INT_LEADING_ZERO = /^0\d+/;
const RE_DECIMAL = /^-?\d{1,3}(?:[.,]\d{3})*[,]\d+$|^-?\d+[.,]\d+$/;
const RE_TIME = /^\d{1,2}:\d{2}(:\d{2})?$/;
const DATE_TIME_REST = "(?:[T ]\\d{2}:\\d{2}(?::\\d{2})?(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?)?";
const RE_ISO_DATE = new RegExp(`^(\\d{4})-(\\d{2})-(\\d{2})(${DATE_TIME_REST})$`);
const RE_SLASH_DATE = new RegExp(`^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})(${DATE_TIME_REST})$`);

function isInt(t: string) { return RE_INT.test(t) && !RE_INT_LEADING_ZERO.test(t); }
function isDateLike(v: string) {
  return normalizeDateLike(v) != null;
}
function hasDateTimePart(v: string) {
  const n = normalizeDateLike(v);
  return n != null && /[T ]\d{2}:\d{2}(:\d{2})?/.test(n);
}

type ColumnStats = { maxLen: number; hasNull: boolean; allInt: boolean; allDecimal: boolean; allDateLike: boolean; hasTimePart: boolean; allTime: boolean; sampleCount: number };
function newStats(): ColumnStats { return { maxLen: 0, hasNull: false, allInt: true, allDecimal: true, allDateLike: true, hasTimePart: false, allTime: true, sampleCount: 0 }; }

function updateStats(s: ColumnStats, raw: unknown) {
  const v = raw == null ? "" : String(raw), trimmed = v.trim();
  if (trimmed === "") { s.hasNull = true; return; }
  s.sampleCount++;
  if (v.length > s.maxLen) s.maxLen = v.length;
  if (s.allInt && !isInt(trimmed)) s.allInt = false;
  if (s.allDecimal && !RE_DECIMAL.test(trimmed) && !isInt(trimmed)) s.allDecimal = false;
  const dateLike = isDateLike(trimmed), dateTime = hasDateTimePart(trimmed);
  if (s.allDateLike && !dateLike) s.allDateLike = false;
  if (dateTime) s.hasTimePart = true;
  if (s.allTime && !RE_TIME.test(trimmed)) s.allTime = false;
}

function textSqlType(maxLen: number) {
  const padded = Math.max(50, Math.ceil(maxLen * 1.25), maxLen + 32);
  return padded > 4000 ? "NVARCHAR(MAX)" : `NVARCHAR(${padded})`;
}

function columnsFromStats(headers: string[], stats: ColumnStats[]): ParsedColumn[] {
  const used = new Map<string, number>();
  return headers.map((header, index) => {
    let name = sqlIdentifier(header || `col_${index + 1}`);
    const n = (used.get(name) ?? 0) + 1; used.set(name, n);
    if (n > 1) name = `${name}_${n}`;
    const s = stats[index] ?? newStats();
    const sqlType = s.sampleCount === 0 ? "NVARCHAR(255)"
      : s.allInt ? "BIGINT"
      : s.allDecimal ? "DECIMAL(18,4)"
      : s.allDateLike && s.hasTimePart ? "DATETIME2"
      : s.allDateLike ? "DATE"
      : s.allTime ? "TIME"
      : textSqlType(s.maxLen);
    return { originalName: header, sqlName: name, sqlType, nullable: s.hasNull };
  });
}

// ─── Clean converter (igual importer-bulk-blob.ts) ─────
function makeCleanConverter(type: string): (v: unknown) => string {
  if (type === "BIGINT") return v => (v == null || String(v).trim() === "") ? "" : String(v).trim();
  if (type.startsWith("DECIMAL")) {
    return v => {
      if (v == null || String(v).trim() === "") return "";
      const s = String(v).trim();
      const num = Number(s.includes(",") ? s.replaceAll(".", "").replace(",", ".") : s);
      return isNaN(num) ? "" : num.toFixed(4);
    };
  }
  if (type === "DATE") {
    return v => {
      if (v == null || String(v).trim() === "") return "";
      const s = String(v).trim();
      return normalizeDateLike(s)?.slice(0, 10) ?? "";
    };
  }
  if (type === "DATETIME2") {
    return v => {
      if (v == null || String(v).trim() === "") return "";
      const s = String(v).trim();
      const iso = normalizeDateLike(s) ?? s;
      return new Date(iso).toISOString().replace("T", " ").replace("Z", "");
    };
  }
  if (type === "TIME") return v => (v == null || String(v).trim() === "") ? "" : String(v).trim();
  return v => {
    if (v == null || String(v).trim() === "") return '""';
    return '"' + String(v).replace(/"/g, '""') + '"';
  };
}

// ─── File Hash ────────────────────────────────────────
function fileHash(path: string): string {
  const sz = statSync(path);
  return createHash("md5")
    .update(`${sz.size}:${sz.mtimeMs}`)
    .digest("hex");
}

// ─── Preview CSV ──────────────────────────────────────
async function previewCsv(path: string) {
  const { encoding, separator } = await detectFileHints(path);
  const sampleRows: string[][] = [];
  let headers: string[] = [], stats: ColumnStats[] = [], count = 0;

  const STATS_SAMPLE_LIMIT = 50_000;
  for await (const row of csvPipeStream(createReadStream(path), encoding, separator)) {
    if (!headers.length) { headers = row.map(String); stats = headers.map(newStats); continue; }
    count++;
    if (sampleRows.length < 20) sampleRows.push(row.map(v => v ?? ""));
    if (count <= STATS_SAMPLE_LIMIT) headers.forEach((_, i) => { stats[i] ??= newStats(); updateStats(stats[i], row[i]); });
  }

  const columns = columnsFromStats(headers, stats);
  return { columns, rowCount: count, encoding, separator };
}

// ─── Preview XLSX ─────────────────────────────────────
async function previewXlsx(path: string) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("Planilha sem abas");

  let headers: string[] = [], stats: ColumnStats[] = [];
  let count = 0;
  const STATS_SAMPLE_LIMIT = 50_000;

  sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const values = (Array.isArray(row.values) ? row.values.slice(1) : [])
      .map(v => v == null ? "" : v instanceof Date ? v.toISOString() : typeof v === "object" ? String((v as { text?: string; result?: unknown }).text ?? (v as { result?: unknown }).result ?? "") : String(v));
    if (rowNumber === 1) { headers = values; stats = headers.map(newStats); return; }
    count++;
    if (count <= STATS_SAMPLE_LIMIT) headers.forEach((_, i) => { stats[i] ??= newStats(); updateStats(stats[i], values[i]); });
  });

  const columns = columnsFromStats(headers, stats);
  return { columns, rowCount: count, encoding: "xlsx", separator: null };
}

// ─── Conversão stream simulada (sem blob/network) ─────
async function simulateConvert(file: string, columns: ParsedColumn[], encoding: string, separator: string): Promise<{ ms: number; lineCount: number }> {
  const converters = columns.map(c => makeCleanConverter(c.sqlType));
  const sink = new PassThrough();
  // descarta output
  sink.resume();

  const t0 = Date.now();
  let lineCount = 0;

  for await (const row of csvPipeStream(createReadStream(file), encoding, separator)) {
    if (lineCount === 0) { lineCount++; continue; } // skip header
    const converted = converters.map((fn, i) => fn(row[i]));
    const csvLine = converted.join("|");
    const rh = createHash("md5").update(csvLine).digest("hex");
    sink.write(csvLine + "|" + rh + "\n");
    lineCount++;
  }
  sink.end();

  const ms = Date.now() - t0;
  // lineCount já contém o header skip
  const dataLines = lineCount - 1; // primeira iteração foi header
  return { ms, lineCount: dataLines };
}

// ─── Main ─────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const previewOnly = args.includes("--preview-only");
  const fullMode = args.includes("--full");

  if (!previewOnly && !fullMode) {
    console.log("Modo: --preview-only (default). Use --full para incluir simulação de conversão.");
  }

  const files = readdirSync(OUTPUT_DIR)
    .filter(f => [".csv", ".xlsx"].includes(extname(f).toLowerCase()))
    .sort();

  console.log(`\n══════════════════════════════════════════════════════════════════════════════`);
  console.log(`  Catálogo da pasta output: ${files.length} arquivos`);
  console.log(`  Diretório: ${OUTPUT_DIR}`);
  console.log(`  Modo: ${fullMode ? "FULL (preview + conversão)" : "PREVIEW-ONLY"}`);
  console.log(`══════════════════════════════════════════════════════════════════════════════\n`);

  const results: FileMetrics[] = [];
  const tGlobal = Date.now();

  for (const f of files) {
    const fullPath = resolve(OUTPUT_DIR, f);
    const ext = extname(f).toLowerCase();
    const sz = statSync(fullPath).size;
    const hash = fileHash(fullPath);

    console.log(`[${results.length + 1}/${files.length}] ${f} (${(sz / 1024 / 1024).toFixed(2)} MB)...`);

    // Preview
    const t0 = Date.now();
    let preview: { columns: ParsedColumn[]; rowCount: number; encoding: string; separator: string | null };
    if (ext === ".csv") {
      preview = await previewCsv(fullPath);
    } else if (ext === ".xlsx") {
      preview = await previewXlsx(fullPath);
    } else {
      continue;
    }
    const previewMs = Date.now() - t0;

    // Summarize col types
    const typeCount = new Map<string, number>();
    for (const c of preview.columns) {
      const base = c.sqlType.replace(/\(.*\)/, "").replace(/^\d+$/, "NVARCHAR");
      typeCount.set(base, (typeCount.get(base) ?? 0) + 1);
    }
    const colTypes = [...typeCount.entries()].map(([t, n]) => `${t} x${n}`).join(", ");

    let convertMs: number | null = null;
    let convertRowsPerSec: number | null = null;

    if (fullMode && preview.rowCount > 0) {
      const conv = await simulateConvert(fullPath, preview.columns, preview.encoding, preview.separator ?? ",");
      convertMs = conv.ms;
      convertRowsPerSec = Math.round(conv.lineCount / (conv.ms / 1000));
    }

    results.push({
      name: f,
      ext,
      sizeBytes: sz,
      sizeMB: (sz / 1024 / 1024).toFixed(2),
      rows: preview.rowCount,
      cols: preview.columns.length,
      previewMs,
      convertMs,
      convertRowsPerSec,
      fileHash: hash,
      encoding: preview.encoding,
      separator: preview.separator,
      colTypes,
    });

    console.log(`   → ${preview.rowCount.toLocaleString()} linhas, ${preview.columns.length} colunas, preview ${previewMs}ms${convertMs != null ? `, convert ${convertMs}ms (${convertRowsPerSec?.toLocaleString()} rows/s)` : ""}`);
  }

  const totalMs = Date.now() - tGlobal;

  // ─── Summary ─────────────────────────────────────────
  console.log(`\n══════════════════════════════════════════════════════════════════════════════`);
  console.log(`  RESUMO`);
  console.log(`══════════════════════════════════════════════════════════════════════════════`);
  console.log(`  Total de arquivos:           ${results.length}`);
  console.log(`  Tempo total de scan:         ${totalMs}ms (${(totalMs / 1000).toFixed(1)}s)`);
  console.log(`  Total de linhas:             ${results.reduce((s, r) => s + r.rows, 0).toLocaleString()}`);
  console.log(`  Total de bytes:              ${(results.reduce((s, r) => s + r.sizeBytes, 0) / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  Tempo acumulado de preview:  ${results.reduce((s, r) => s + r.previewMs, 0)}ms`);
  if (fullMode) {
    console.log(`  Tempo acumulado de conversão: ${results.reduce((s, r) => s + (r.convertMs ?? 0), 0)}ms`);
  }
  console.log(`\n`);

  // Table
  const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
  console.log(pad("Arquivo", 35) + pad("Ext", 6) + pad("Tamanho", 10) + pad("Linhas", 12) + pad("Cols", 5) + pad("Preview", 9) + (fullMode ? pad("Convert", 9) + pad("rows/s", 10) : "") + "Colunas");
  console.log("─".repeat(fullMode ? 120 : 90));

  for (const r of results) {
    const line = pad(r.name, 35)
      + pad(r.ext, 6)
      + pad(r.sizeMB + " MB", 10)
      + pad(r.rows.toLocaleString(), 12)
      + pad(String(r.cols), 5)
      + pad(r.previewMs + "ms", 9)
      + (fullMode
        ? pad(r.convertMs != null ? r.convertMs + "ms" : "-", 9)
          + pad(r.convertRowsPerSec != null ? r.convertRowsPerSec.toLocaleString() : "-", 10)
        : "")
      + r.colTypes;
    console.log(line);
  }

  console.log(`\n══════════════════════════════════════════════════════════════════════════════`);

  // ─── JSON output para processamento ──────────────────
  console.log(`\n// JSON:\n${JSON.stringify(results, null, 2)}`);

  // ─── Top 5 maiores ───────────────────────────────────
  console.log(`\n══════════════════════════════════════════════════════════════════════════════`);
  console.log(`  TOP 5 MAIORES ARQUIVOS`);
  const top5 = [...results].sort((a, b) => b.sizeBytes - a.sizeBytes).slice(0, 5);
  for (const r of top5) {
    const pct = (r.sizeBytes / results.reduce((s, x) => s + x.sizeBytes, 0) * 100).toFixed(1);
    console.log(`  ${r.name.padEnd(35)} ${r.sizeMB.padStart(8)} MB  ${r.rows.toLocaleString().padStart(12)} linhas  (${pct}% do total)`);
  }

  // ─── Previews mais lentos ────────────────────────────
  console.log(`\n  TOP 5 PREVIEWS MAIS LENTOS`);
  const topPrev = [...results].sort((a, b) => b.previewMs - a.previewMs).slice(0, 5);
  for (const r of topPrev) {
    console.log(`  ${r.name.padEnd(35)} ${String(r.previewMs).padStart(6)}ms  ${r.rows.toLocaleString().padStart(12)} linhas`);
  }

  if (fullMode) {
    console.log(`\n  TOP 5 CONVERSÕES MAIS LENTAS`);
    const topConv = [...results].filter(r => r.convertMs != null).sort((a, b) => (b.convertMs ?? 0) - (a.convertMs ?? 0)).slice(0, 5);
    for (const r of topConv) {
      console.log(`  ${r.name.padEnd(35)} ${String(r.convertMs).padStart(6)}ms  ${r.convertRowsPerSec?.toLocaleString().padStart(10)} rows/s`);
    }
  }

  console.log(`\n══════════════════════════════════════════════════════════════════════════════\n`);
}

void main().catch(e => { console.error(e); process.exit(1); });