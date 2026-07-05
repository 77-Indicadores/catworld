import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "..", ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const sep = t.indexOf("="); if (sep === -1) continue;
    const key = t.slice(0, sep).trim(); let val = t.slice(sep + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
}
import sql from "mssql";
import { previewFile, rowsFromFile } from "../src/server/uploads/parser.ts";
function parseSqlUrl(url) {
  const without = url.replace(/^sqlserver:\/\//i, "");
  const [hostPort, ...rest] = without.split(";").filter(Boolean);
  const [server, port] = hostPort.split(":");
  const params = Object.fromEntries(rest.map(p => { const i = p.indexOf("="); return [p.slice(0,i).toLowerCase(), p.slice(i+1)]; }));
  return { server, port: port ? Number(port) : 1433, database: params.database, user: params.user, password: params.password, options: { encrypt: params.encrypt !== "false", trustServerCertificate: params.trustservercertificate === "true" }, requestTimeout: 600_000, connectionTimeout: 30_000, pool: { max: 10, min: 2, idleTimeoutMillis: 30_000 } };
}
function toSqlType(type) {
  if (type === "BIGINT") return sql.BigInt;
  if (type === "DATE") return sql.Date;
  if (type === "DATETIME2") return sql.DateTime2;
  if (type === "TIME") return sql.Time;
  if (type.startsWith("DECIMAL")) return sql.Decimal(18, 4);
  const m = type.match(/NVARCHAR\((\d+)\)/);
  return m ? sql.NVarChar(Number(m[1])) : sql.NVarChar(sql.MAX);
}
function makeConverter(type) {
  if (type === "BIGINT") return v => v == null || String(v).trim() === "" ? null : String(v);
  if (type.startsWith("DECIMAL")) return v => { if (v == null || String(v).trim() === "") return null; const s = String(v).trim(); return Number(s.includes(",") ? s.replaceAll(".", "").replace(",", ".") : s); };
  if (type === "DATE" || type === "DATETIME2") return v => { if (v == null || String(v).trim() === "") return null; const s = String(v).trim(), br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})(.*)$/), iso = br ? `${br[3]}-${br[2]}-${br[1]}${br[4]}` : s; return new Date(type === "DATE" ? iso.slice(0, 10) + "T00:00:00Z" : iso); };
  if (type === "TIME") return v => v == null || String(v).trim() === "" ? null : String(v).trim();
  return v => v == null || String(v).trim() === "" ? null : String(v);
}
const FILE = process.argv[2];
const SCHEMA = "dbo";
const preview = await previewFile(FILE);
const converters = preview.columns.map(c => makeConverter(c.sqlType));
const bulkCols = preview.columns.map(c => ({ name: c.sqlName, type: toSqlType(c.sqlType) }));
const pool = await new sql.ConnectionPool(parseSqlUrl(process.env.CATWORLD_DATABASE_URL)).connect();
const colDefs = preview.columns.map(c => `[${c.sqlName}] ${c.sqlType} NULL`).join(",");
async function runBulk(tableLock) {
  const TABLE = `bm_test_${tableLock ? "lock" : "nolock"}_${Date.now()}`;
  await pool.request().query(`IF OBJECT_ID(N'${SCHEMA}.${TABLE}',N'U') IS NOT NULL DROP TABLE [${SCHEMA}].[${TABLE}]; CREATE TABLE [${SCHEMA}].[${TABLE}] (${colDefs})`);
  const t = Date.now();
  let batch = [], total = 0;
  const flush = async () => {
    if (!batch.length) return;
    const bulk = new sql.Table(`${SCHEMA}.${TABLE}`);
    bulk.create = false;
    for (const col of bulkCols) bulk.columns.add(col.name, col.type, { nullable: true });
    for (const row of batch) bulk.rows.add(...converters.map((fn, i) => fn(row[preview.columns[i].sqlName])));
    await new sql.Request(pool).bulk(bulk, { tableLock });
    total += batch.length; batch = [];
  };
  for await (const row of rowsFromFile(FILE, preview.columns)) { batch.push(row); if (batch.length >= 50000) await flush(); }
  await flush();
  const ms = Date.now() - t;
  await pool.request().query(`DROP TABLE [${SCHEMA}].[${TABLE}]`).catch(() => {});
  return ms;
}
console.log(`\nArquivo: ${FILE} · ${preview.rowCount.toLocaleString()} linhas · ${preview.columns.length} colunas`);
console.log("\nTestando SEM tableLock...");
const msNoLock = await runBulk(false);
console.log(`  Resultado: ${msNoLock}ms (${Math.round(preview.rowCount / (msNoLock/1000))} rows/s)`);
console.log("\nTestando COM tableLock: true...");
const msLock = await runBulk(true);
console.log(`  Resultado: ${msLock}ms (${Math.round(preview.rowCount / (msLock/1000))} rows/s)`);
console.log(`\nGanho: ${Math.round((msNoLock - msLock) / msNoLock * 100)}% mais rápido com tableLock`);
await pool.close();
