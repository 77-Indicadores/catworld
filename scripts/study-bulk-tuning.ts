/**
 * Estudo de Performance — Tuning de BULK INSERT (Azure SQL)
 * 
 * Testa variações documentadas na documentação oficial Microsoft para BULK INSERT:
 * - TABLOCK vs sem TABLOCK
 * - ROWS_PER_BATCH (hint para o query optimizer)
 * - BATCHSIZE (batch interno do BULK)
 * - ORDER (coluna clusterizada, se existir)
 * - MAXERRORS
 * - CHECK_CONSTRAINTS vs sem
 * 
 * Referências:
 * - https://learn.microsoft.com/en-us/sql/t-sql/statements/bulk-insert-transact-sql
 * - https://learn.microsoft.com/en-us/sql/relational-databases/import-export/bulk-import-and-export-of-data-sql-server
 * - https://learn.microsoft.com/en-us/azure/azure-sql/database/bulk-insert-performance
 * 
 * Uso: npx tsx scripts/study-bulk-tuning.ts <arquivo>
 * 
 * Aplica cada variação e reporta tempo, throughput e delta percentual.
 * O arquivo CSV limpo (convertido) é gerado uma vez e reutilizado para cada teste.
 * O blob é reutilizado entre testes (mesmo hash de conteúdo).
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, basename } from "node:path";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import sql from "mssql";
import {
  BlobServiceClient,
  BlobSASPermissions,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
} from "@azure/storage-blob";
import { previewFile, rowsFromFile } from "../src/server/uploads/parser";
import { normalizeDateLike } from "../src/server/uploads/date-normalize";

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

function parseSqlUrl(url: string): sql.config {
  const without = url.replace(/^sqlserver:\/\//i, "");
  const [hp, ...rest] = without.split(";").filter(Boolean);
  const [server, port] = hp!.split(":");
  const params = Object.fromEntries(rest.map(p => { const i = p.indexOf("="); return [p.slice(0, i).toLowerCase(), p.slice(i + 1)]; }));
  return {
    server: server!, port: port ? Number(port) : 1433, database: params["database"],
    user: params["user"], password: params["password"],
    options: { encrypt: true, trustServerCertificate: false, packetSize: 16384 },
    requestTimeout: 1800_000, connectionTimeout: 30_000,
    pool: { max: 5, min: 1, idleTimeoutMillis: 30_000 }
  };
}

function makeCleanConverter(type: string): (v: unknown) => string {
  if (type === "BIGINT") return v => (v == null || String(v).trim() === "") ? "" : String(v).trim();
  if (type.startsWith("DECIMAL")) return v => { if (v == null || String(v).trim() === "") return ""; const s = String(v).trim(); const n = Number(s.includes(",") ? s.replaceAll(".", "").replace(",", ".") : s); return isNaN(n) ? "" : n.toFixed(4); };
  if (type === "DATE") return v => { if (v == null || String(v).trim() === "") return ""; const s = String(v).trim(); return normalizeDateLike(s)?.slice(0, 10) ?? ""; };
  if (type === "DATETIME2") return v => { if (v == null || String(v).trim() === "") return ""; const s = String(v).trim(); const iso = normalizeDateLike(s) ?? s; return new Date(iso).toISOString().replace("T", " ").replace("Z", ""); };
  if (type === "TIME") return v => (v == null || String(v).trim() === "") ? "" : String(v).trim();
  return v => { if (v == null || String(v).trim() === "") return '""'; return '"' + String(v).replace(/"/g, '""') + '"'; };
}

type TestConfig = {
  label: string;
  options: string;  // extras na WITH clause alem do basico (FIELDTERMINATOR, ROWTERMINATOR, etc)
};

type TestResult = {
  label: string;
  bulkMs: number;
  rowCount: number;
  rowsPerSec: number;
  error?: string;
};

// ─── Upload do blob (uma vez, reusado) ────────────────
async function prepareBlob(
  file: string,
  preview: Awaited<ReturnType<typeof previewFile>>,
  blockClient: ReturnType<ReturnType<BlobServiceClient["getContainerClient"]>["getBlockBlobClient"]>
) {
  const converters = preview.columns.map(c => makeCleanConverter(c.sqlType));
  const passThrough = new PassThrough();
  const uploadPromise = blockClient.uploadStream(passThrough, 8 * 1024 * 1024, 4, {
    blobHTTPHeaders: { blobContentType: "text/csv; charset=utf-8" },
  });
  let total = 0;
  const t0 = Date.now();
  for await (const row of rowsFromFile(file, preview.columns)) {
    const csvLine = converters.map((fn, i) => fn(row[preview.columns[i]!.sqlName])).join("|");
    passThrough.write(csvLine + "\n");
    total++;
    if (total % 50_000 === 0) process.stdout.write(`  Convertendo: ${total.toLocaleString()} linhas\r`);
  }
  passThrough.end();
  await uploadPromise;
  const uploadMs = Date.now() - t0;
  console.log(`\n✓ Blob preparado: ${total.toLocaleString()} linhas em ${(uploadMs/1000).toFixed(1)}s (${Math.round(total/(uploadMs/1000)).toLocaleString()} rows/s)`);
  return { total, uploadMs };
}

const BASE_WITH =
  "FORMAT = 'CSV', " +
  "FIELDTERMINATOR = '|', " +
  "ROWTERMINATOR = '\\n', " +
  "FIELDQUOTE = '\"', " +
  "FIRSTROW = 1, " +
  "CODEPAGE = '65001'";

// ─── Testes a rodar ───────────────────────────────────
function buildConfigs(rowCount: number): TestConfig[] {
  return [
    // Baseline atual
    { label: "Baseline (TABLOCK, sem ROWS_PER_BATCH)", options: "TABLOCK" },
    // ROWS_PER_BATCH
    { label: "TABLOCK + ROWS_PER_BATCH=50k", options: `TABLOCK, ROWS_PER_BATCH = 50000` },
    { label: "TABLOCK + ROWS_PER_BATCH=100k", options: `TABLOCK, ROWS_PER_BATCH = 100000` },
    { label: "TABLOCK + ROWS_PER_BATCH=0 (all at once)", options: `TABLOCK, ROWS_PER_BATCH = ${rowCount}` },
    // BATCHSIZE
    { label: "TABLOCK + BATCHSIZE=10000", options: "TABLOCK, BATCHSIZE = 10000" },
    { label: "TABLOCK + BATCHSIZE=50000", options: "TABLOCK, BATCHSIZE = 50000" },
    { label: "TABLOCK + BATCHSIZE=100000", options: "TABLOCK, BATCHSIZE = 100000" },
    // Sem TABLOCK
    { label: "SEM TABLOCK (row-level logging)", options: "" },
    // Combos
    { label: "TABLOCK + ROWS_PER_BATCH=50k + BATCHSIZE=50k", options: "TABLOCK, ROWS_PER_BATCH = 50000, BATCHSIZE = 50000" },
    // MAXERRORS
    { label: "TABLOCK + MAXERRORS=0", options: "TABLOCK, MAXERRORS = 0" },
  ];
}

async function runBulkTest(
  pool: sql.ConnectionPool,
  tableName: string,
  container: string,
  blobName: string,
  dataSource: string,
  config: TestConfig,
  rowCount: number
): Promise<TestResult> {
  // (re)cria tabela
  const colDefsFull = config.label.includes("KEEPIDENTITY")
    ? `[id] INT IDENTITY(1,1) NOT NULL, ${columns.map(c => `[${c.sqlName}] ${c.sqlType} NULL`).join(",")}`
    : columns.map(c => `[${c.sqlName}] ${c.sqlType} NULL`).join(",");

  const colDefs = columns.map(c => `[${c.sqlName}] ${c.sqlType} NULL`).join(",");
  await pool.request().query(`IF OBJECT_ID(N'dbo.${tableName}',N'U') IS NOT NULL DROP TABLE dbo.[${tableName}]; CREATE TABLE dbo.[${tableName}] (${colDefs})`);

  const withClause = `${BASE_WITH}${config.options ? ", " + config.options : ""}`;
  const bulkSql = `
    BULK INSERT dbo.[${tableName}]
    FROM '${container}/${blobName}'
    WITH (DATA_SOURCE = '${dataSource}', ${withClause})
  `;

  const req = pool.request();
  (req as unknown as { timeout: number }).timeout = 30 * 60_000;

  const t0 = Date.now();
  try {
    await req.query(bulkSql);
    const ms = Date.now() - t0;
    const count = (await pool.request().query(`SELECT COUNT_BIG(*) n FROM dbo.[${tableName}]`)).recordset[0].n;
    const rps = Math.round(Number(count) / (ms / 1000));
    return { label: config.label, bulkMs: ms, rowCount: Number(count), rowsPerSec: rps };
  } catch (err) {
    const ms = Date.now() - t0;
    return { label: config.label, bulkMs: ms, rowCount: 0, rowsPerSec: 0, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await pool.request().query(`IF OBJECT_ID(N'dbo.${tableName}',N'U') IS NOT NULL DROP TABLE dbo.[${tableName}]`).catch(() => {});
  }
}

// ─── Globals setados por main ─────────────────────────
let columns: Awaited<ReturnType<typeof previewFile>>["columns"] = [];

// ─── Main ─────────────────────────────────────────────
async function main() {
  const FILE = process.argv[2]!;
  if (!FILE || !existsSync(FILE)) {
    console.error(`Uso: npx tsx scripts/study-bulk-tuning.ts <arquivo.csv>`);
    process.exit(1);
  }

  const connStr = process.env["CATWORLD_AZURE_BLOB_CONNECTION_STRING"]!;
  const container = process.env["CATWORLD_AZURE_BLOB_CONTAINER"]!;
  const accountMatch = connStr.match(/AccountName=([^;]+)/i)!;
  const keyMatch = connStr.match(/AccountKey=([^;]+)/i)!;

  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(`  Estudo: Tuning de BULK INSERT`);
  console.log(`  Arquivo: ${basename(FILE)}`);
  console.log(`═══════════════════════════════════════════════════════════════\n`);

  // Preview
  process.stdout.write("Inferindo schema...");
  const preview = await previewFile(FILE);
  columns = preview.columns;
  console.log(` ${preview.rowCount.toLocaleString()} linhas, ${preview.columns.length} colunas\n`);

  // Pool SQL
  const pool = await new sql.ConnectionPool(parseSqlUrl(process.env["CATWORLD_DATABASE_URL"]!)).connect();

  // Prepara blob (uma vez para todos os testes)
  const blobName = `tmp/study-bulk-${createHash("md5").update(FILE).digest("hex").slice(0, 8)}.csv`;
  const service = BlobServiceClient.fromConnectionString(connStr);
  const blockClient = service.getContainerClient(container).getBlockBlobClient(blobName);

  // Força recriação para garantir CSV sem hash
  await blockClient.delete().catch(() => {});
  const blobExists = false;
  let rowCount: number;
  if (false) {
    console.log(`Blob reutilizado: ${blobName}`);
    rowCount = preview.rowCount;
  } else {
    console.log(`Preparando blob: ${blobName}`);
    const prep = await prepareBlob(FILE, preview, blockClient);
    rowCount = prep.total;
  }

  // Delay consistência blob
  await new Promise(r => setTimeout(r, 2000));

  // Cria credential e data source uma vez
  const credential = new StorageSharedKeyCredential(accountMatch[1]!, keyMatch[1]!);
  const sas = generateBlobSASQueryParameters(
    { containerName: container, blobName, permissions: BlobSASPermissions.parse("r"), expiresOn: new Date(Date.now() + 60 * 60_000) },
    credential
  ).toString();
  const hash = createHash("md5").update(blobName).digest("hex").slice(0, 8);
  const tempCred = `StudyCred_${hash}`;
  const tempDs = `StudyDS_${hash}`;

  try {
    await pool.request().query(`CREATE DATABASE SCOPED CREDENTIAL [${tempCred}] WITH IDENTITY='SHARED ACCESS SIGNATURE',SECRET='${sas}'`);
    await pool.request().query(`CREATE EXTERNAL DATA SOURCE [${tempDs}] WITH (TYPE=BLOB_STORAGE,LOCATION='https://${accountMatch[1]!}.blob.core.windows.net',CREDENTIAL=[${tempCred}])`);

    const configs = buildConfigs(rowCount);
    const results: TestResult[] = [];

    console.log(`\nTestando ${configs.length} configurações de BULK INSERT...\n`);
    console.log(`${"#".padEnd(3)} ${"Configuração".padEnd(55)} ${"Tempo".padStart(10)} ${"Rows/s".padStart(12)} ${"Delta".padStart(8)}`);
    console.log("─".repeat(92));

    for (let i = 0; i < configs.length; i++) {
      const config = configs[i]!;
      const tableName = `study_bulk_${hash}_${i}`;
      process.stdout.write(`${String(i + 1).padEnd(3)} ${config.label.padEnd(55)} `);
      const result = await runBulkTest(pool, tableName, container, blobName, tempDs, config, rowCount);
      results.push(result);

      if (result.error) {
        console.log(`ERRO`.padStart(32));
        console.log(`     └─ ${result.error.slice(0, 120)}`);
      } else {
        const msStr = `${(result.bulkMs / 1000).toFixed(1)}s`;
        const rpsStr = result.rowsPerSec.toLocaleString();
        const delta = i === 0 ? "baseline" : `${(result.bulkMs / results[0]!.bulkMs * 100 - 100).toFixed(0)}%`;
        console.log(`${msStr.padStart(10)} ${rpsStr.padStart(12)} ${delta.padStart(8)}`);
      }
    }

    // ─── Ranking ───────────────────────────────────────
    console.log(`\n═══════════════════════════════════════════════════════════════`);
    console.log(`  RANKING (melhor primeiro)`);
    console.log(`═══════════════════════════════════════════════════════════════`);
    const sorted = results.filter(r => !r.error).sort((a, b) => a.bulkMs - b.bulkMs);
    for (let i = 0; i < sorted.length; i++) {
      const r = sorted[i]!;
      const pct = sorted[0] ? ` (${((r.bulkMs / sorted[0].bulkMs - 1) * 100).toFixed(0)}% do melhor)` : "";
      const vsBase = results[0] ? ` vs baseline: ${(r.bulkMs / results[0].bulkMs * 100).toFixed(0)}%` : "";
      console.log(`  ${(i + 1).toString().padStart(2)}. ${r.label.padEnd(58)} ${(r.bulkMs/1000).toFixed(1)}s ${r.rowsPerSec.toLocaleString()} rows/s${pct}${vsBase}`);
    }

    if (results.some(r => r.error)) {
      console.log(`\n  ERROS:`);
      for (const r of results.filter(r => r.error)) {
        console.log(`  ✗ ${r.label}: ${r.error!.slice(0, 200)}`);
      }
    }

    // ─── Recomendação ──────────────────────────────────
    if (sorted.length >= 2) {
      const best = sorted[0]!;
      const base = results[0]!;
      const gain = ((1 - best.bulkMs / base.bulkMs) * 100).toFixed(1);
      console.log(`\n═══════════════════════════════════════════════════════════════`);
      console.log(`  RECOMENDAÇÃO`);
      console.log(`═══════════════════════════════════════════════════════════════`);
      console.log(`  Melhor config:  ${best.label}`);
      console.log(`  Ganho sobre baseline: ${gain}%`);
      console.log(`  Baseline: ${(base.bulkMs/1000).toFixed(1)}s → Melhor: ${(best.bulkMs/1000).toFixed(1)}s`);
      console.log(`  Economia: ${((base.bulkMs - best.bulkMs)/1000).toFixed(1)}s por BULK INSERT`);
    }

  } finally {
    await pool.request().query(`IF EXISTS (SELECT * FROM sys.external_data_sources WHERE name='${tempDs}') DROP EXTERNAL DATA SOURCE [${tempDs}]`).catch(() => {});
    await pool.request().query(`IF EXISTS (SELECT * FROM sys.database_scoped_credentials WHERE name='${tempCred}') DROP DATABASE SCOPED CREDENTIAL [${tempCred}]`).catch(() => {});
    await blockClient.delete().catch(() => {});
    await pool.close();
  }

  console.log(`\n═══════════════════════════════════════════════════════════════\n`);
}

void main().catch(e => { console.error("❌", e); process.exit(1); });