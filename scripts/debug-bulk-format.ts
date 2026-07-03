/**
 * Diagnóstico do BULK INSERT: gera amostra do TSV e testa com 3 colunas
 * para isolar qual coluna causa o problema.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import sql from "mssql";
import { BlobServiceClient, BlobSASPermissions, StorageSharedKeyCredential, generateBlobSASQueryParameters } from "@azure/storage-blob";
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

function makeCleanConverter(type: string): (v: unknown) => string {
  if (type === "BIGINT") return v => (v == null || String(v).trim() === "") ? "" : String(v).trim();
  if (type.startsWith("DECIMAL")) return v => {
    if (v == null || String(v).trim() === "") return "";
    const s = String(v).trim();
    const num = Number(s.includes(",") ? s.replaceAll(".", "").replace(",", ".") : s);
    if (isNaN(num)) return "";
    return num.toFixed(4); // Evita notação científica
  };
  if (type === "DATE") return v => { if (v == null || String(v).trim() === "") return ""; const s = String(v).trim(), br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/); return br ? `${br[3]}-${br[2]}-${br[1]}` : s.slice(0, 10); };
  if (type === "DATETIME2") return v => { if (v == null || String(v).trim() === "") return ""; const s = String(v).trim(), br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})(.*)/); const iso = br ? `${br[3]}-${br[2]}-${br[1]}${br[4]}` : s; return new Date(iso).toISOString().replace("T", " ").replace("Z", ""); };
  if (type === "TIME") return v => (v == null || String(v).trim() === "") ? "" : String(v).trim();
  return v => (v == null || String(v).trim() === "") ? "" : String(v).trim().replace(/\t/g, " ").replace(/[\n\r]/g, " ");
}

async function trySingleColumn(col: { sqlName: string; sqlType: string }, rows: Record<string, unknown>[], pool: sql.ConnectionPool, connStr: string, container: string) {
  const blobName = `tmp/debug-${Date.now()}-${col.sqlName}.tsv`;
  const conv = makeCleanConverter(col.sqlType);
  const lines = rows.map(r => conv(r[col.sqlName]) + "\n").join("");
  const service = BlobServiceClient.fromConnectionString(connStr);
  const cc = service.getContainerClient(container);
  const blockClient = cc.getBlockBlobClient(blobName);
  await blockClient.upload(Buffer.from(lines, "utf8"), Buffer.byteLength(lines, "utf8"), { blobHTTPHeaders: { blobContentType: "text/plain; charset=utf-8" } });

  const accountMatch = connStr.match(/AccountName=([^;]+)/i)!;
  const keyMatch = connStr.match(/AccountKey=([^;]+)/i)!;
  const cred = new StorageSharedKeyCredential(accountMatch[1]!, keyMatch[1]!);
  const sas = generateBlobSASQueryParameters({ containerName: container, blobName, permissions: BlobSASPermissions.parse("r"), expiresOn: new Date(Date.now() + 10 * 60_000) }, cred).toString();

  const TABLE = `dbg_${createHash("md5").update(blobName).digest("hex").slice(0, 8)}`;
  const tempCred = `DbgCred_${TABLE}`;
  const tempDs = `DbgDS_${TABLE}`;

  try {
    await pool.request().query(`CREATE TABLE dbo.[${TABLE}] ([${col.sqlName}] ${col.sqlType} NULL)`);
    await pool.request().query(`CREATE DATABASE SCOPED CREDENTIAL [${tempCred}] WITH IDENTITY='SHARED ACCESS SIGNATURE',SECRET='${sas}'`);
    await pool.request().query(`CREATE EXTERNAL DATA SOURCE [${tempDs}] WITH (TYPE=BLOB_STORAGE,LOCATION='https://${accountMatch[1]!}.blob.core.windows.net',CREDENTIAL=[${tempCred}])`);
    await pool.request().query(`BULK INSERT dbo.[${TABLE}] FROM '${container}/${blobName}' WITH (DATA_SOURCE='${tempDs}',FORMAT='CSV',FIELDTERMINATOR='\t',ROWTERMINATOR='\n',FIRSTROW=1,TABLOCK,CODEPAGE='65001')`);
    return true;
  } catch (e) {
    return (e as Error).message;
  } finally {
    await pool.request().query(`IF EXISTS (SELECT * FROM sys.external_data_sources WHERE name='${tempDs}') DROP EXTERNAL DATA SOURCE [${tempDs}]`).catch(() => {});
    await pool.request().query(`IF EXISTS (SELECT * FROM sys.database_scoped_credentials WHERE name='${tempCred}') DROP DATABASE SCOPED CREDENTIAL [${tempCred}]`).catch(() => {});
    await pool.request().query(`IF OBJECT_ID(N'dbo.${TABLE}',N'U') IS NOT NULL DROP TABLE dbo.[${TABLE}]`).catch(() => {});
    await blockClient.delete().catch(() => {});
  }
}

async function main() {
  const FILE = process.argv[2]!;
  if (!FILE || !existsSync(FILE)) { console.error(`Uso: npx tsx scripts/debug-bulk-format.ts <arquivo>`); process.exit(1); }

  const connStr = process.env["CATWORLD_AZURE_BLOB_CONNECTION_STRING"]!;
  const container = process.env["CATWORLD_AZURE_BLOB_CONTAINER"]!;

  console.log("\nInferindo schema...");
  const preview = await previewFile(FILE);
  console.log(`✓ ${preview.rowCount.toLocaleString()} linhas · ${preview.columns.length} colunas`);
  console.log(`Tipos: ${[...new Set(preview.columns.map(c => c.sqlType))].join(", ")}\n`);

  // Coleta 200 linhas de amostra para debug
  const sample: Record<string, unknown>[] = [];
  for await (const row of rowsFromFile(FILE, preview.columns)) { sample.push(row); if (sample.length >= 200) break; }
  console.log(`Amostra coletada: ${sample.length} linhas\n`);

  // Grava TSV de amostra local para inspeção manual
  const convs = preview.columns.map(c => makeCleanConverter(c.sqlType));
  const sampleTsv = sample.map(row => convs.map((fn, i) => fn(row[preview.columns[i]!.sqlName])).join("\t")).join("\n");
  writeFileSync("sample-debug.tsv", sampleTsv, "utf8");
  console.log("→ Amostra gravada em sample-debug.tsv (inspecione se há chars estranhos)\n");

  const pool = await new sql.ConnectionPool(parseSqlUrl(process.env["CATWORLD_DATABASE_URL"]!)).connect();

  // Testa coluna por coluna com a amostra
  console.log("Testando cada coluna individualmente...");
  const errors: string[] = [];
  for (const col of preview.columns) {
    process.stdout.write(`  [${col.sqlType.padEnd(20)}] ${col.sqlName.padEnd(40)} `);
    const result = await trySingleColumn(col, sample, pool, connStr, container);
    if (result === true) { console.log("✓"); }
    else { console.log(`✗  ${result.slice(0, 80)}`); errors.push(`${col.sqlName} (${col.sqlType}): ${result}`); }
  }

  await pool.close();

  if (errors.length) {
    console.log(`\n❌ Colunas com problema:\n${errors.map(e => "  " + e).join("\n")}`);
  } else {
    console.log("\n✅ Todas as colunas passaram individualmente — problema pode ser combinação");
  }
}

void main().catch(e => { console.error("❌", e.message); process.exit(1); });
