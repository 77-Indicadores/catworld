import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import sql from "mssql";
import { previewFile, rowsFromFile } from "../src/server/uploads/parser";

// Carrega .env
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
  const [hostPort, ...rest] = without.split(";").filter(Boolean);
  const [server, port] = hostPort!.split(":");
  const params = Object.fromEntries(rest.map(p => { const i = p.indexOf("="); return [p.slice(0, i).toLowerCase(), p.slice(i + 1)]; }));
  return { server: server!, port: port ? Number(port) : 1433, database: params["database"], user: params["user"], password: params["password"], options: { encrypt: params["encrypt"] !== "false", trustServerCertificate: params["trustservercertificate"] === "true" }, requestTimeout: 600_000, connectionTimeout: 30_000, pool: { max: 10, min: 2, idleTimeoutMillis: 30_000 } };
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

async function main() {
  const FILE = process.argv[2]!;
  const SCHEMA = "dbo";
  const BATCH = 50_000;

  const preview = await previewFile(FILE);
  const converters = preview.columns.map(c => makeConverter(c.sqlType));
  const bulkCols = preview.columns.map(c => ({ name: c.sqlName, type: toSqlType(c.sqlType) }));
  const colDefs = preview.columns.map(c => `[${c.sqlName}] ${c.sqlType} NULL`).join(",");
  const pool = await new sql.ConnectionPool(parseSqlUrl(process.env["CATWORLD_DATABASE_URL"]!)).connect();

  async function runBulk(tableLock: boolean): Promise<number> {
    const TABLE = `bm_${tableLock ? "lock" : "nolk"}_${Date.now()}`;
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
      process.stdout.write(`\r   ${total.toLocaleString()} linhas inseridas`);
    };
    for await (const row of rowsFromFile(FILE, preview.columns)) { batch.push(row); if (batch.length >= BATCH) await flush(); }
    await flush();
    const ms = Date.now() - t;
    await pool.request().query(`DROP TABLE [${SCHEMA}].[${TABLE}]`).catch(() => {});
    return ms;
  }

  console.log(`\nArquivo: ${FILE}`);
  console.log(`${preview.rowCount.toLocaleString()} linhas · ${preview.columns.length} colunas\n`);

  console.log("Rodada 1 — SEM tableLock:");
  const ms1 = await runBulk(false);
  console.log(`\n  -> ${ms1}ms  (${Math.round(preview.rowCount / (ms1 / 1000)).toLocaleString()} rows/s)\n`);

  console.log("Rodada 2 — COM tableLock: true:");
  const ms2 = await runBulk(true);
  console.log(`\n  -> ${ms2}ms  (${Math.round(preview.rowCount / (ms2 / 1000)).toLocaleString()} rows/s)\n`);

  const gain = Math.round((ms1 - ms2) / ms1 * 100);
  console.log(`Ganho com tableLock: ${gain > 0 ? "+" : ""}${gain}%`);

  await pool.close();
}

void main();
