/**
 * Só rodada BULK INSERT blob — TDS já medido: 1027846ms (17.1 min)
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
  return { server: server!, port: port ? Number(port) : 1433, database: params["database"], user: params["user"], password: params["password"], options: { encrypt: true, trustServerCertificate: false, packetSize: 16384 }, requestTimeout: 1800_000, connectionTimeout: 30_000, pool: { max: 5, min: 1, idleTimeoutMillis: 30_000 } };
}

function makeCleanConverter(type: string): (v: unknown) => string {
  if (type === "BIGINT") return v => (v == null || String(v).trim() === "") ? "" : String(v).trim();
  if (type.startsWith("DECIMAL")) return v => { if (v == null || String(v).trim() === "") return ""; const s = String(v).trim(); const n = Number(s.includes(",") ? s.replaceAll(".", "").replace(",", ".") : s); return isNaN(n) ? "" : n.toFixed(4); };
  if (type === "DATE") return v => { if (v == null || String(v).trim() === "") return ""; const s = String(v).trim(), br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/); return br ? `${br[3]}-${br[2]}-${br[1]}` : s.slice(0, 10); };
  if (type === "DATETIME2") return v => { if (v == null || String(v).trim() === "") return ""; const s = String(v).trim(), br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})(.*)/); const iso = br ? `${br[3]}-${br[2]}-${br[1]}${br[4]}` : s; return new Date(iso).toISOString().replace("T", " ").replace("Z", ""); };
  if (type === "TIME") return v => (v == null || String(v).trim() === "") ? "" : String(v).trim();
  return v => { if (v == null || String(v).trim() === "") return '""'; return '"' + String(v).replace(/"/g, '""') + '"'; };
}

async function main() {
  const FILE = process.argv[2]!;
  const connStr = process.env["CATWORLD_AZURE_BLOB_CONNECTION_STRING"]!;
  const container = process.env["CATWORLD_AZURE_BLOB_CONTAINER"]!;
  const accountMatch = connStr.match(/AccountName=([^;]+)/i)!;
  const keyMatch = connStr.match(/AccountKey=([^;]+)/i)!;

  console.log(`\nInferindo schema...`);
  const preview = await previewFile(FILE);
  console.log(`✓ ${preview.rowCount.toLocaleString()} linhas · ${preview.columns.length} colunas\n`);

  const TABLE = `bm_blob_${Date.now()}`;
  const colDefs = preview.columns.map(c => `[${c.sqlName}] ${c.sqlType} NULL`).join(",");
  const pool = await new sql.ConnectionPool(parseSqlUrl(process.env["CATWORLD_DATABASE_URL"]!)).connect();
  await pool.request().query(`IF OBJECT_ID(N'dbo.${TABLE}',N'U') IS NOT NULL DROP TABLE dbo.[${TABLE}]; CREATE TABLE dbo.[${TABLE}] (${colDefs})`);

  const blobName = `tmp/bench-${Date.now()}.csv`;
  const service = BlobServiceClient.fromConnectionString(connStr);
  const blockClient = service.getContainerClient(container).getBlockBlobClient(blobName);
  const converters = preview.columns.map(c => makeCleanConverter(c.sqlType));

  const tTotal = Date.now();
  console.log(`Convertendo e fazendo upload para blob...`);
  const passThrough = new PassThrough();
  const uploadPromise = blockClient.uploadStream(passThrough, 8 * 1024 * 1024, 4, { blobHTTPHeaders: { blobContentType: "text/csv; charset=utf-8" } });
  let total = 0;
  for await (const row of rowsFromFile(FILE, preview.columns)) {
    passThrough.write(converters.map((fn, i) => fn(row[preview.columns[i]!.sqlName])).join("|") + "\n");
    total++;
    if (total % 100_000 === 0) process.stdout.write(`  ${total.toLocaleString()} linhas convertidas\r`);
  }
  passThrough.end();
  await uploadPromise;
  const uploadMs = Date.now() - tTotal;
  console.log(`✓ Convert+upload: ${(uploadMs/1000).toFixed(1)}s\n`);

  const credential = new StorageSharedKeyCredential(accountMatch[1]!, keyMatch[1]!);
  const sas = generateBlobSASQueryParameters({ containerName: container, blobName, permissions: BlobSASPermissions.parse("r"), expiresOn: new Date(Date.now() + 60 * 60_000) }, credential).toString();
  const hash = createHash("md5").update(blobName).digest("hex").slice(0, 8);
  const tempCred = `BenchCred_${hash}`;
  const tempDs = `BenchDS_${hash}`;

  try {
    await pool.request().query(`CREATE DATABASE SCOPED CREDENTIAL [${tempCred}] WITH IDENTITY='SHARED ACCESS SIGNATURE',SECRET='${sas}'`);
    await pool.request().query(`CREATE EXTERNAL DATA SOURCE [${tempDs}] WITH (TYPE=BLOB_STORAGE,LOCATION='https://${accountMatch[1]!}.blob.core.windows.net',CREDENTIAL=[${tempCred}])`);

    console.log(`Executando BULK INSERT (timeout 30 min)...`);
    const tBulk = Date.now();
    const req = pool.request();
    (req as unknown as { timeout: number }).timeout = 30 * 60_000;
    await req.query(`BULK INSERT dbo.[${TABLE}] FROM '${container}/${blobName}' WITH (DATA_SOURCE='${tempDs}',FORMAT='CSV',FIELDTERMINATOR='|',ROWTERMINATOR='\n',FIELDQUOTE='"',FIRSTROW=1,TABLOCK,CODEPAGE='65001')`);
    const bulkMs = Date.now() - tBulk;
    const totalMs = Date.now() - tTotal;

    const count = (await pool.request().query(`SELECT COUNT_BIG(*) n FROM dbo.[${TABLE}]`)).recordset[0].n;
    const rowsPerSec = Math.round(Number(count) / (totalMs / 1000));

    console.log(`\n╔══════════════════════════════════════════════════════════╗`);
    console.log(`║  BULK INSERT from blob — ${preview.rowCount.toLocaleString()} linhas`);
    console.log(`╠══════════════════════════════════════════════════════════╣`);
    console.log(`║  Convert+upload:  ${String((uploadMs/1000).toFixed(1)+"s").padEnd(38)}║`);
    console.log(`║  SQL BULK INSERT: ${String((bulkMs/1000).toFixed(1)+"s").padEnd(38)}║`);
    console.log(`║  Total:           ${String((totalMs/1000).toFixed(1)+"s  ("+((totalMs/60000)).toFixed(1)+" min)").padEnd(38)}║`);
    console.log(`║  Throughput:      ${String(rowsPerSec.toLocaleString()+" rows/s").padEnd(38)}║`);
    console.log(`╠══════════════════════════════════════════════════════════╣`);
    console.log(`║  TDS (rodada anterior): 1027846ms = 17.1 min            ║`);
    const speedup = (1027846 / totalMs).toFixed(2);
    const pct = Math.round((1 - totalMs/1027846)*100);
    console.log(`║  Speedup: ${speedup}x   Economia: ${pct}%                         ║`);
    console.log(`╚══════════════════════════════════════════════════════════╝\n`);

  } finally {
    await pool.request().query(`IF EXISTS (SELECT * FROM sys.external_data_sources WHERE name='${tempDs}') DROP EXTERNAL DATA SOURCE [${tempDs}]`).catch(() => {});
    await pool.request().query(`IF EXISTS (SELECT * FROM sys.database_scoped_credentials WHERE name='${tempCred}') DROP DATABASE SCOPED CREDENTIAL [${tempCred}]`).catch(() => {});
    await pool.request().query(`IF OBJECT_ID(N'dbo.${TABLE}',N'U') IS NOT NULL DROP TABLE dbo.[${TABLE}]`).catch(() => {});
    await blockClient.delete().catch(() => {});
    await pool.close();
  }
}

void main().catch(e => { console.error("❌", e.message); process.exit(1); });
