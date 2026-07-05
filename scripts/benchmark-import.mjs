/**
 * Benchmark do pipeline de importação.
 * Uso: node --env-file=.env scripts/benchmark-import.mjs <caminho-do-csv>
 * Ou:  npx tsx scripts/benchmark-import.mjs <caminho-do-csv>
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Carrega .env manualmente se necessário
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "..", ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const sep = t.indexOf("=");
    if (sep === -1) continue;
    const key = t.slice(0, sep).trim();
    let val = t.slice(sep + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
}

const filePath = process.argv[2];
if (!filePath) { console.error("Uso: node scripts/benchmark-import.mjs <caminho-do-csv>"); process.exit(1); }

// Importa módulos do projeto via tsx/ts-node path mapping
const { previewFile, rowsFromFile } = await import("../src/server/uploads/parser.ts");
import sql from "mssql";

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

const SCHEMA = "dbo";
const TABLE  = `bm_test_${Date.now()}`;
const BATCH  = 50_000;

console.log(`\n📂 Arquivo: ${filePath}`);

// 1. Preview (tipo detection + contagem de linhas)
let t = Date.now();
console.log("\n⏱  [1/4] Inferindo schema...");
const preview = await previewFile(filePath);
const previewMs = Date.now() - t;
console.log(`   ✓ ${preview.columns.length} colunas · ${preview.rowCount.toLocaleString()} linhas · ${previewMs}ms`);
console.log("   Tipos:", preview.columns.slice(0, 6).map(c => `${c.sqlName}:${c.sqlType}`).join(", "), preview.columns.length > 6 ? "..." : "");

// 2. Conecta ao banco
console.log("\n⏱  [2/4] Conectando ao Azure SQL...");
t = Date.now();
const pool = await new sql.ConnectionPool(parseSqlUrl(process.env.CATWORLD_DATABASE_URL)).connect();
console.log(`   ✓ Conectado em ${Date.now() - t}ms`);

const colDefs = preview.columns.map(c => `[${c.sqlName}] ${c.sqlType} NULL`).join(",");
const converters = preview.columns.map(c => makeConverter(c.sqlType));
const bulkCols = preview.columns.map(c => ({ name: c.sqlName, type: toSqlType(c.sqlType) }));

try {
  // 3. Cria tabela de staging e faz bulk insert
  await pool.request().query(`IF OBJECT_ID(N'${SCHEMA}.${TABLE}',N'U') IS NOT NULL DROP TABLE [${SCHEMA}].[${TABLE}]; CREATE TABLE [${SCHEMA}].[${TABLE}] (${colDefs})`);

  console.log(`\n⏱  [3/4] Bulk insert (batch=${BATCH.toLocaleString()} rows)...`);
  t = Date.now();

  let batch = [], total = 0, flushCount = 0, totalFlushMs = 0;

  const flush = async () => {
    if (!batch.length) return;
    const flushStart = Date.now();
    const bulk = new sql.Table(`${SCHEMA}.${TABLE}`);
    bulk.create = false;
    for (const col of bulkCols) bulk.columns.add(col.name, col.type, { nullable: true });
    for (const row of batch) bulk.rows.add(...converters.map((fn, i) => fn(row[preview.columns[i].sqlName])));
    await new sql.Request(pool).bulk(bulk);
    totalFlushMs += Date.now() - flushStart;
    total += batch.length;
    flushCount++;
    process.stdout.write(`\r   ${total.toLocaleString()} / ${preview.rowCount.toLocaleString()} linhas inseridas (${flushCount} batches)`);
    batch = [];
  };

  for await (const row of rowsFromFile(filePath, preview.columns)) {
    batch.push(row);
    if (batch.length >= BATCH) await flush();
  }
  await flush();

  const insertMs = Date.now() - t;
  console.log(`\n   ✓ ${total.toLocaleString()} linhas em ${insertMs}ms`);
  console.log(`   → Throughput: ${Math.round(total / (insertMs / 1000)).toLocaleString()} linhas/seg`);
  console.log(`   → Tempo SQL (bulk):  ${totalFlushMs}ms (${Math.round(totalFlushMs/insertMs*100)}% do tempo)`);
  console.log(`   → Tempo leitura CSV: ${insertMs - totalFlushMs}ms (${Math.round((insertMs - totalFlushMs)/insertMs*100)}% do tempo)`);

  // 4. Contagem final
  console.log("\n⏱  [4/4] Verificando contagem...");
  t = Date.now();
  const { recordset } = await pool.request().query(`SELECT COUNT_BIG(*) AS n FROM [${SCHEMA}].[${TABLE}]`);
  console.log(`   ✓ ${Number(recordset[0].n).toLocaleString()} linhas no banco · ${Date.now() - t}ms`);

  console.log("\n📊 RESUMO");
  console.log(`   Preview (scan):  ${previewMs}ms`);
  console.log(`   Bulk insert:     ${insertMs}ms`);
  console.log(`   TOTAL estimado:  ${previewMs + insertMs}ms (${((previewMs + insertMs)/1000/60).toFixed(1)} min)`);
  console.log(`   (No import real o scan NÃO acontece duas vezes com a otimização)`);
  console.log(`   Estimativa pós-fix: ${insertMs}ms (${(insertMs/1000/60).toFixed(1)} min)\n`);

} finally {
  await pool.request().query(`IF OBJECT_ID(N'${SCHEMA}.${TABLE}',N'U') IS NOT NULL DROP TABLE [${SCHEMA}].[${TABLE}]`).catch(() => {});
  await pool.close();
}
