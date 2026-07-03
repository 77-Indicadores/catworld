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

function parseSqlUrl(url: string): sql.config {
  const without = url.replace(/^sqlserver:\/\//i, "");
  const [hostPort, ...rest] = without.split(";").filter(Boolean);
  const [server, port] = hostPort!.split(":");
  const params = Object.fromEntries(rest.map(p => { const i = p.indexOf("="); return [p.slice(0, i).toLowerCase(), p.slice(i + 1)]; }));
  return { server: server!, port: port ? Number(port) : 1433, database: params["database"], user: params["user"], password: params["password"], options: { encrypt: params["encrypt"] !== "false", trustServerCertificate: params["trustservercertificate"] === "true" }, requestTimeout: 600_000, connectionTimeout: 30_000, pool: { max: 10, min: 5, idleTimeoutMillis: 30_000 } };
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

const FILE = process.argv[2]!;
const BATCH = 50_000;

async function main() {
  const preview = await previewFile(FILE);
  const converters = preview.columns.map(c => makeConverter(c.sqlType));
  const bulkCols = preview.columns.map(c => ({ name: c.sqlName, type: toSqlType(c.sqlType) }));
  const colDefs = preview.columns.map(c => `[${c.sqlName}] ${c.sqlType} NULL`).join(",");
  const SCHEMA = "dbo";

  console.log(`\nArquivo: ${FILE}`);
  console.log(`${preview.rowCount.toLocaleString()} linhas · ${preview.columns.length} colunas\n`);

  const pool = await new sql.ConnectionPool(parseSqlUrl(process.env["CATWORLD_DATABASE_URL"]!)).connect();

  function makeBulk(tableName: string, rows: Record<string, unknown>[]): sql.Table {
    const bulk = new sql.Table(`${SCHEMA}.${tableName}`);
    bulk.create = false;
    for (const col of bulkCols) bulk.columns.add(col.name, col.type, { nullable: true });
    for (const row of rows) bulk.rows.add(...converters.map((fn, i) => fn(row[preview.columns[i]!.sqlName])));
    return bulk;
  }

  async function prepare(tableName: string) {
    await pool.request().query(`IF OBJECT_ID(N'${SCHEMA}.${tableName}',N'U') IS NOT NULL DROP TABLE [${SCHEMA}].[${tableName}]; CREATE TABLE [${SCHEMA}].[${tableName}] (${colDefs})`);
  }
  async function cleanup(tableName: string) {
    await pool.request().query(`IF OBJECT_ID(N'${SCHEMA}.${tableName}',N'U') IS NOT NULL DROP TABLE [${SCHEMA}].[${tableName}]`).catch(() => {});
  }

  // ── Rodada 1: sequencial + tableLock (abordagem atual do importer) ──
  console.log("Rodada 1 — Sequencial + tableLock: true");
  const T1 = `bm_seq_lock_${Date.now()}`;
  await prepare(T1);
  let t = Date.now(), total = 0, batch: Record<string, unknown>[] = [];
  const flushSeqLock = async () => {
    if (!batch.length) return;
    await new sql.Request(pool).bulk(makeBulk(T1, batch), { tableLock: true });
    total += batch.length; batch = [];
    process.stdout.write(`\r   ${total.toLocaleString()} / ${preview.rowCount.toLocaleString()}`);
  };
  for await (const row of rowsFromFile(FILE, preview.columns)) { batch.push(row); if (batch.length >= BATCH) await flushSeqLock(); }
  await flushSeqLock();
  const ms1 = Date.now() - t;
  await cleanup(T1);
  console.log(`\n  -> ${ms1}ms · ${Math.round(total / (ms1 / 1000)).toLocaleString()} rows/s\n`);

  // ── Rodada 2: paralelo N=3, sem tableLock ──
  const CONCURRENCY = 3;
  console.log(`Rodada 2 — Paralelo (N=${CONCURRENCY}) + tableLock: false`);
  const T2 = `bm_par3_${Date.now()}`;
  await prepare(T2);
  t = Date.now(); total = 0; batch = [];
  const active: Promise<void>[] = [];
  const submitBatch = (rows: Record<string, unknown>[]) => {
    const p: Promise<void> = new sql.Request(pool).bulk(makeBulk(T2, rows), { tableLock: false })
      .then(() => { total += rows.length; process.stdout.write(`\r   ${total.toLocaleString()} / ${preview.rowCount.toLocaleString()}`); })
      .finally(() => { const idx = active.indexOf(p); if (idx !== -1) active.splice(idx, 1); });
    active.push(p);
  };
  for await (const row of rowsFromFile(FILE, preview.columns)) {
    batch.push(row);
    if (batch.length >= BATCH) {
      if (active.length >= CONCURRENCY) await Promise.race(active);
      submitBatch(batch.splice(0));
    }
  }
  if (batch.length) { if (active.length >= CONCURRENCY) await Promise.race(active); submitBatch(batch.splice(0)); }
  await Promise.all(active);
  const ms2 = Date.now() - t;
  await cleanup(T2);
  console.log(`\n  -> ${ms2}ms · ${Math.round(total / (ms2 / 1000)).toLocaleString()} rows/s\n`);

  // ── Rodada 3: paralelo N=5, sem tableLock ──
  const CONCURRENCY2 = 5;
  console.log(`Rodada 3 — Paralelo (N=${CONCURRENCY2}) + tableLock: false`);
  const T3 = `bm_par5_${Date.now()}`;
  await prepare(T3);
  t = Date.now(); total = 0; batch = [];
  const active2: Promise<void>[] = [];
  const submitBatch2 = (rows: Record<string, unknown>[]) => {
    const p: Promise<void> = new sql.Request(pool).bulk(makeBulk(T3, rows), { tableLock: false })
      .then(() => { total += rows.length; process.stdout.write(`\r   ${total.toLocaleString()} / ${preview.rowCount.toLocaleString()}`); })
      .finally(() => { const idx = active2.indexOf(p); if (idx !== -1) active2.splice(idx, 1); });
    active2.push(p);
  };
  for await (const row of rowsFromFile(FILE, preview.columns)) {
    batch.push(row);
    if (batch.length >= BATCH) {
      if (active2.length >= CONCURRENCY2) await Promise.race(active2);
      submitBatch2(batch.splice(0));
    }
  }
  if (batch.length) { if (active2.length >= CONCURRENCY2) await Promise.race(active2); submitBatch2(batch.splice(0)); }
  await Promise.all(active2);
  const ms3 = Date.now() - t;
  await cleanup(T3);
  console.log(`\n  -> ${ms3}ms · ${Math.round(total / (ms3 / 1000)).toLocaleString()} rows/s\n`);

  console.log("═══════════════════════════════════════");
  console.log(`Sequencial + tableLock:  ${ms1}ms  (${(ms1/1000/60).toFixed(1)} min)`);
  console.log(`Paralelo N=3 + nolock:   ${ms2}ms  (${(ms2/1000/60).toFixed(1)} min)  ${ms1 > ms2 ? "+" : ""}${Math.round((ms1 - ms2) / ms1 * 100)}%`);
  console.log(`Paralelo N=5 + nolock:   ${ms3}ms  (${(ms3/1000/60).toFixed(1)} min)  ${ms1 > ms3 ? "+" : ""}${Math.round((ms1 - ms3) / ms1 * 100)}%`);
  console.log("═══════════════════════════════════════");

  await pool.close();
}

void main();
