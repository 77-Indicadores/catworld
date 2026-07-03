/**
 * Benchmark de tuning: packet size × batch size × bulk options
 * Testa combinações para achar o ponto ótimo para Azure SQL S0
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import sql from "mssql";
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

function parseSqlUrl(url: string, packetSize = 4096): sql.config {
  const without = url.replace(/^sqlserver:\/\//i, "");
  const [hostPort, ...rest] = without.split(";").filter(Boolean);
  const [server, port] = hostPort!.split(":");
  const params = Object.fromEntries(rest.map(p => { const i = p.indexOf("="); return [p.slice(0, i).toLowerCase(), p.slice(i + 1)]; }));
  return {
    server: server!, port: port ? Number(port) : 1433,
    database: params["database"], user: params["user"], password: params["password"],
    options: { encrypt: params["encrypt"] !== "false", trustServerCertificate: params["trustservercertificate"] === "true", packetSize },
    requestTimeout: 600_000, connectionTimeout: 30_000,
    pool: { max: 10, min: 2, idleTimeoutMillis: 30_000 }
  };
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

async function run(label: string, file: string, preview: Awaited<ReturnType<typeof previewFile>>, packetSize: number, batchSize: number, tableLock: boolean) {
  const SCHEMA = "dbo";
  const TABLE = `bm_${Date.now()}`;
  const converters = preview.columns.map(c => makeConverter(c.sqlType));
  const bulkCols = preview.columns.map(c => ({ name: c.sqlName, type: toSqlType(c.sqlType) }));
  const colDefs = preview.columns.map(c => `[${c.sqlName}] ${c.sqlType} NULL`).join(",");

  const pool = await new sql.ConnectionPool(parseSqlUrl(process.env["CATWORLD_DATABASE_URL"]!, packetSize)).connect();
  await pool.request().query(`IF OBJECT_ID(N'${SCHEMA}.${TABLE}',N'U') IS NOT NULL DROP TABLE [${SCHEMA}].[${TABLE}]; CREATE TABLE [${SCHEMA}].[${TABLE}] (${colDefs})`);

  const t = Date.now();
  let batch: Record<string, unknown>[] = [], total = 0;

  const flush = async () => {
    if (!batch.length) return;
    const bulk = new sql.Table(`${SCHEMA}.${TABLE}`);
    bulk.create = false;
    for (const col of bulkCols) bulk.columns.add(col.name, col.type, { nullable: true });
    for (const row of batch) bulk.rows.add(...converters.map((fn, i) => fn(row[preview.columns[i]!.sqlName])));
    await new sql.Request(pool).bulk(bulk, { tableLock });
    total += batch.length; batch = [];
  };

  for await (const row of rowsFromFile(file, preview.columns)) {
    batch.push(row);
    if (batch.length >= batchSize) await flush();
  }
  await flush();

  const ms = Date.now() - t;
  await pool.request().query(`IF OBJECT_ID(N'${SCHEMA}.${TABLE}',N'U') IS NOT NULL DROP TABLE [${SCHEMA}].[${TABLE}]`).catch(() => {});
  await pool.close();

  console.log(`  ${label.padEnd(45)} ${String(ms).padStart(7)}ms   ${String(Math.round(total / (ms / 1000))).padStart(6)} rows/s`);
  return ms;
}

async function main() {
  const FILE = process.argv[2]!;
  const preview = await previewFile(FILE);
  console.log(`\nArquivo: ${FILE}`);
  console.log(`${preview.rowCount.toLocaleString()} linhas · ${preview.columns.length} colunas\n`);
  console.log(`${"Configuração".padEnd(45)} ${"Tempo".padStart(8)}   ${"Throughput".padStart(10)}`);
  console.log("─".repeat(70));

  // Baseline atual
  const base = await run("packet=4096  batch=50k  tableLock=true  [atual]", FILE, preview, 4096, 50_000, true);

  // Packet size
  await run("packet=8192  batch=50k  tableLock=true", FILE, preview, 8192, 50_000, true);
  await run("packet=16384 batch=50k  tableLock=true", FILE, preview, 16384, 50_000, true);
  await run("packet=32767 batch=50k  tableLock=true", FILE, preview, 32767, 50_000, true);

  // Batch size com melhor packet
  await run("packet=32767 batch=25k  tableLock=true", FILE, preview, 32767, 25_000, true);
  await run("packet=32767 batch=100k tableLock=true", FILE, preview, 32767, 100_000, true);
  await run("packet=32767 batch=200k tableLock=true", FILE, preview, 32767, 200_000, true);

  // Sem tableLock com melhor packet
  await run("packet=32767 batch=50k  tableLock=false", FILE, preview, 32767, 50_000, false);

  console.log("─".repeat(70));
  console.log(`\nBaseline: ${base}ms`);
}

void main();
