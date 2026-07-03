/**
 * Benchmark: BULK INSERT from blob vs TDS bulk copy
 * Mede o tempo total de inserção com os dois métodos no mesmo arquivo.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import sql from "mssql";
import { BlobServiceClient, BlobSASPermissions, StorageSharedKeyCredential, generateBlobSASQueryParameters } from "@azure/storage-blob";
import { PassThrough } from "node:stream";
import { previewFile, rowsFromFile } from "../src/server/uploads/parser";

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
  return { server: server!, port: port ? Number(port) : 1433, database: params["database"], user: params["user"], password: params["password"], options: { encrypt: true, trustServerCertificate: false, packetSize: 16384 }, requestTimeout: 600_000, connectionTimeout: 30_000, pool: { max: 5, min: 1, idleTimeoutMillis: 30_000 } };
}

function toSqlType(type: string) {
  if (type === "BIGINT") return sql.BigInt;
  if (type === "DATE") return sql.Date;
  if (type === "DATETIME2") return sql.DateTime2;
  if (type === "TIME") return sql.Time;
  if (type.startsWith("DECIMAL")) return sql.Decimal(18, 4);
  const m = type.match(/NVARCHAR\((\d+)\)/);
  return m ? sql.NVarChar(Number(m[1])) : sql.NVarChar(sql.MAX);
}

function makeConverter(type: string): (v: unknown) => unknown {
  if (type === "BIGINT") return v => v == null || String(v).trim() === "" ? null : String(v);
  if (type.startsWith("DECIMAL")) return v => { if (v == null || String(v).trim() === "") return null; const s = String(v).trim(); return Number(s.includes(",") ? s.replaceAll(".", "").replace(",", ".") : s); };
  if (type === "DATE" || type === "DATETIME2") return v => { if (v == null || String(v).trim() === "") return null; const s = String(v).trim(), br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})(.*)$/), iso = br ? `${br[3]}-${br[2]}-${br[1]}${br[4]}` : s; return new Date(type === "DATE" ? iso.slice(0, 10) + "T00:00:00Z" : iso); };
  if (type === "TIME") return v => v == null || String(v).trim() === "" ? null : String(v).trim();
  return v => v == null || String(v).trim() === "" ? null : String(v);
}

function makeCleanConverter(type: string): (v: unknown) => string {
  if (type === "BIGINT") return v => (v == null || String(v).trim() === "") ? "" : String(v).trim();
  if (type.startsWith("DECIMAL")) return v => { if (v == null || String(v).trim() === "") return ""; const s = String(v).trim(); const n = Number(s.includes(",") ? s.replaceAll(".", "").replace(",", ".") : s); return isNaN(n) ? "" : n.toFixed(4); };
  if (type === "DATE") return v => { if (v == null || String(v).trim() === "") return ""; const s = String(v).trim(), br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/); return br ? `${br[3]}-${br[2]}-${br[1]}` : s.slice(0, 10); };
  if (type === "DATETIME2") return v => { if (v == null || String(v).trim() === "") return ""; const s = String(v).trim(), br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})(.*)/); const iso = br ? `${br[3]}-${br[2]}-${br[1]}${br[4]}` : s; return new Date(iso).toISOString().replace("T", " ").replace("Z", ""); };
  if (type === "TIME") return v => (v == null || String(v).trim() === "") ? "" : String(v).trim();
  // NVARCHAR: entre aspas, escape de aspas internas como ""
  return v => { if (v == null || String(v).trim() === "") return '""'; return '"' + String(v).replace(/"/g, '""') + '"'; };
}

async function runTds(file: string, preview: Awaited<ReturnType<typeof previewFile>>, pool: sql.ConnectionPool) {
  const TABLE = `bm_tds_${Date.now()}`;
  const colDefs = preview.columns.map(c => `[${c.sqlName}] ${c.sqlType} NULL`).join(",");
  await pool.request().query(`IF OBJECT_ID(N'dbo.${TABLE}',N'U') IS NOT NULL DROP TABLE dbo.[${TABLE}]; CREATE TABLE dbo.[${TABLE}] (${colDefs})`);
  const converters = preview.columns.map(c => makeConverter(c.sqlType));
  const bulkCols = preview.columns.map(c => ({ name: c.sqlName, type: toSqlType(c.sqlType) }));
  let batch: Record<string, unknown>[] = [], total = 0;
  const t = Date.now();
  const flush = async () => {
    if (!batch.length) return;
    const bulk = new sql.Table(`dbo.${TABLE}`); bulk.create = false;
    for (const col of bulkCols) bulk.columns.add(col.name, col.type, { nullable: true });
    for (const row of batch) bulk.rows.add(...(converters.map((fn, i) => fn(row[preview.columns[i]!.sqlName])) as Parameters<typeof bulk.rows.add>));
    await new sql.Request(pool).bulk(bulk, { tableLock: true });
    total += batch.length; batch = [];
  };
  for await (const row of rowsFromFile(file, preview.columns)) { batch.push(row); if (batch.length >= 50_000) await flush(); }
  await flush();
  const ms = Date.now() - t;
  await pool.request().query(`IF OBJECT_ID(N'dbo.${TABLE}',N'U') IS NOT NULL DROP TABLE dbo.[${TABLE}]`).catch(() => {});
  return { total, ms, rowsPerSec: Math.round(total / (ms / 1000)) };
}

async function runBulkBlob(file: string, preview: Awaited<ReturnType<typeof previewFile>>, pool: sql.ConnectionPool) {
  const TABLE = `bm_blob_${Date.now()}`;
  const colDefs = preview.columns.map(c => `[${c.sqlName}] ${c.sqlType} NULL`).join(",");
  await pool.request().query(`IF OBJECT_ID(N'dbo.${TABLE}',N'U') IS NOT NULL DROP TABLE dbo.[${TABLE}]; CREATE TABLE dbo.[${TABLE}] (${colDefs})`);

  const connStr = process.env["CATWORLD_AZURE_BLOB_CONNECTION_STRING"]!;
  const container = process.env["CATWORLD_AZURE_BLOB_CONTAINER"]!;
  const accountMatch = connStr.match(/AccountName=([^;]+)/i)!;
  const keyMatch = connStr.match(/AccountKey=([^;]+)/i)!;
  const blobName = `tmp/bench-${Date.now()}.tsv`;
  const service = BlobServiceClient.fromConnectionString(connStr);
  const cc = service.getContainerClient(container);
  const blockClient = cc.getBlockBlobClient(blobName);
  const converters = preview.columns.map(c => makeCleanConverter(c.sqlType));

  const t = Date.now();

  // Convert + upload streaming
  const passThrough = new PassThrough();
  const uploadPromise = blockClient.uploadStream(passThrough, 8 * 1024 * 1024, 4, { blobHTTPHeaders: { blobContentType: "text/csv; charset=utf-8" } });
  let total = 0;
  for await (const row of rowsFromFile(file, preview.columns)) {
    passThrough.write(converters.map((fn, i) => fn(row[preview.columns[i]!.sqlName])).join("|") + "\n");
    total++;
  }
  passThrough.end();
  await uploadPromise;
  const uploadMs = Date.now() - t;

  const credential = new StorageSharedKeyCredential(accountMatch[1]!, keyMatch[1]!);
  const sas = generateBlobSASQueryParameters({ containerName: container, blobName, permissions: BlobSASPermissions.parse("r"), expiresOn: new Date(Date.now() + 30 * 60_000) }, credential).toString();
  const tempCred = `BenchCred_${createHash("md5").update(blobName).digest("hex").slice(0, 8)}`;
  const tempDs = `BenchDS_${createHash("md5").update(blobName).digest("hex").slice(0, 8)}`;

  try {
    await pool.request().query(`CREATE DATABASE SCOPED CREDENTIAL [${tempCred}] WITH IDENTITY = 'SHARED ACCESS SIGNATURE', SECRET = '${sas}'`);
    await pool.request().query(`CREATE EXTERNAL DATA SOURCE [${tempDs}] WITH (TYPE = BLOB_STORAGE, LOCATION = 'https://${accountMatch[1]!}.blob.core.windows.net', CREDENTIAL = [${tempCred}])`);
    const t2 = Date.now();
    const bulkReq = pool.request();
    (bulkReq as unknown as { timeout: number }).timeout = 30 * 60_000;
    await bulkReq.query(`BULK INSERT dbo.[${TABLE}] FROM '${container}/${blobName}' WITH (DATA_SOURCE='${tempDs}',FORMAT='CSV',FIELDTERMINATOR='|',ROWTERMINATOR='\n',FIELDQUOTE='"',FIRSTROW=1,TABLOCK,CODEPAGE='65001')`);
    const bulkMs = Date.now() - t2;
    const ms = Date.now() - t;
    return { total, ms, uploadMs, bulkMs, rowsPerSec: Math.round(total / (ms / 1000)) };
  } finally {
    await pool.request().query(`IF EXISTS (SELECT * FROM sys.external_data_sources WHERE name='${tempDs}') DROP EXTERNAL DATA SOURCE [${tempDs}]`).catch(() => {});
    await pool.request().query(`IF EXISTS (SELECT * FROM sys.database_scoped_credentials WHERE name='${tempCred}') DROP DATABASE SCOPED CREDENTIAL [${tempCred}]`).catch(() => {});
    await pool.request().query(`IF OBJECT_ID(N'dbo.${TABLE}',N'U') IS NOT NULL DROP TABLE dbo.[${TABLE}]`).catch(() => {});
    await blockClient.delete().catch(() => {});
  }
}

async function main() {
  const FILE = process.argv[2]!;
  if (!FILE || !existsSync(FILE)) { console.error(`Uso: npx tsx scripts/bench-bulk-vs-tds.ts <arquivo>`); process.exit(1); }

  console.log(`\n═══════════════════════════════════════════════`);
  console.log(`  Benchmark: BULK INSERT blob vs TDS`);
  console.log(`  Arquivo: ${FILE.split(/[/\\]/).pop()}`);
  console.log(`═══════════════════════════════════════════════\n`);

  console.log("Inferindo schema...");
  const preview = await previewFile(FILE);
  console.log(`✓ ${preview.rowCount.toLocaleString()} linhas · ${preview.columns.length} colunas\n`);

  const pool = await new sql.ConnectionPool(parseSqlUrl(process.env["CATWORLD_DATABASE_URL"]!)).connect();

  console.log("Rodada 1 — TDS Bulk Copy (método atual)...");
  const tds = await runTds(FILE, preview, pool);
  console.log(`  → ${tds.ms}ms · ${tds.rowsPerSec.toLocaleString()} rows/s\n`);

  console.log("Rodada 2 — BULK INSERT from Azure Blob (novo método)...");
  const blob = await runBulkBlob(FILE, preview, pool);
  console.log(`  → ${blob.ms}ms total (convert+upload: ${blob.uploadMs}ms · bulk: ${blob.bulkMs}ms) · ${blob.rowsPerSec.toLocaleString()} rows/s\n`);

  await pool.close();

  const speedup = (tds.ms / blob.ms).toFixed(1);
  const saved = Math.round((1 - blob.ms / tds.ms) * 100);
  const minTds = (tds.ms / 60000).toFixed(1);
  const minBlob = (blob.ms / 60000).toFixed(1);

  console.log(`╔═══════════════════════════════════════════════════════╗`);
  console.log(`║  RESULTADO FINAL                                      ║`);
  console.log(`╠═══════════════════════════════════════════════════════╣`);
  console.log(`║  TDS Bulk:            ${String(tds.ms + "ms").padEnd(10)} ${String(tds.rowsPerSec.toLocaleString() + " rows/s").padEnd(18)}║`);
  console.log(`║  BULK INSERT blob:    ${String(blob.ms + "ms").padEnd(10)} ${String(blob.rowsPerSec.toLocaleString() + " rows/s").padEnd(18)}║`);
  console.log(`╠═══════════════════════════════════════════════════════╣`);
  console.log(`║  Speedup: ${speedup}x    Tempo economizado: ${saved}%            ║`);
  console.log(`║  ${minTds} min → ${minBlob} min                                   ║`);
  console.log(`╚═══════════════════════════════════════════════════════╝\n`);
}

void main().catch(e => { console.error("❌", e.message); process.exit(1); });
