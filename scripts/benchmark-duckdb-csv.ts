/**
 * Benchmark: DuckDB Node.js vs csv-parse para leitura de CSV
 * Uso: npx tsx scripts/benchmark-duckdb-csv.ts
 */
import { DuckDBInstance } from "@duckdb/node-api";
import { createReadStream, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "csv-parse";

const ROWS = 500_000;
const CSV_PATH = join(tmpdir(), "catworld_bench.csv");

function generateCsv(rows: number): void {
  const lines = ["id,nome,valor,data,categoria,ativo"];
  for (let i = 0; i < rows; i++) {
    lines.push([
      i,
      `produto_${i}`,
      (i * 1.5).toFixed(2),
      `2024-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
      ["Vendas", "TI", "RH", "Financeiro", "Marketing"][i % 5],
      i % 2 === 0 ? "true" : "false",
    ].join(","));
  }
  writeFileSync(CSV_PATH, lines.join("\n"));
}

async function benchDuckDB(csvPath: string): Promise<{ ms: number; rows: number }> {
  const t = Date.now();
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();

  // DuckDB lê o CSV, detecta tipos e conta rows
  const reader = await conn.runAndReadAll(
    `SELECT COUNT(*) n FROM read_csv_auto('${csvPath.replace(/\\/g, "/")}')`,
  );
  const count = Number(reader.getRows()[0]?.[0] ?? 0);

  const ms = Date.now() - t;
  return { ms, rows: count };
}

async function benchCsvParse(csvPath: string): Promise<{ ms: number; rows: number }> {
  const t = Date.now();
  let count = 0;

  await new Promise<void>((resolve, reject) => {
    createReadStream(csvPath)
      .pipe(parse({ delimiter: ",", from_line: 2, relax_column_count: true }))
      .on("data", () => { count++; })
      .on("end", resolve)
      .on("error", reject);
  });

  return { ms: Date.now() - t, rows: count };
}

async function main() {
  console.log(`\n=== Benchmark: DuckDB vs csv-parse — ${ROWS.toLocaleString()} rows ===\n`);

  process.stdout.write("Gerando CSV sintético...");
  generateCsv(ROWS);
  const sizeMb = (ROWS * 60 / 1024 / 1024).toFixed(1); // ~60 bytes/row
  console.log(` ~${sizeMb} MB\n`);

  // Warm up
  await benchDuckDB(CSV_PATH);
  await benchCsvParse(CSV_PATH);

  // 3 runs each, take best
  const duckTimes: number[] = [];
  const csvTimes: number[] = [];

  for (let i = 0; i < 3; i++) {
    duckTimes.push((await benchDuckDB(CSV_PATH)).ms);
    csvTimes.push((await benchCsvParse(CSV_PATH)).ms);
  }

  const duckBest = Math.min(...duckTimes);
  const csvBest = Math.min(...csvTimes);
  const speedup = (csvBest / duckBest).toFixed(1);

  console.log(`DuckDB read_csv_auto : ${duckBest}ms  (melhor de 3: ${duckTimes.join(", ")}ms)`);
  console.log(`csv-parse            : ${csvBest}ms  (melhor de 3: ${csvTimes.join(", ")}ms)`);
  console.log(`\nSpeedup DuckDB: ${speedup}×`);
  console.log(`Throughput DuckDB  : ${Math.round(ROWS / duckBest * 1000).toLocaleString()} rows/sec`);
  console.log(`Throughput csv-parse: ${Math.round(ROWS / csvBest * 1000).toLocaleString()} rows/sec`);

  unlinkSync(CSV_PATH);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
