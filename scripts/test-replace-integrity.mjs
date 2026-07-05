/**
 * Test: replace mode integrity across multiple uploads
 *
 * Scenarios:
 *  1. Initial import (5 rows)
 *  2. Add rows (5 → 8)          — no phantom rows from v1
 *  3. Remove + add (8 → 6)      — removed rows must disappear
 *  4. Edit a field               — updated value, no duplicate row
 *  5. No change                  — SKIP, table unchanged
 *  6. Full replace (all new)     — all old rows gone
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sql from "mssql";

const BASE_URL = "http://localhost:3000";
const DATASET_ID = "ee9d41e2-f13b-4064-ac0e-c938e4ecd8ea";
const TABLE = "cw_integrity_test";     // SQL table name (from filename)
const FILE_NAME = `${TABLE}.csv`;
const SEP = ";";

// ── helpers ──────────────────────────────────────────────────────────────────

async function getToken() {
  // Read token from veratto .env (already in process via dotenv or hardcoded)
  return "cw_live_luEMBXNaRYa-xjgRI23tqs2gR9njbvOS";
}

function makeCsv(rows) {
  const header = "id;nome;valor\n";
  return header + rows.map(r => `${r.id};${r.nome};${r.valor}`).join("\n") + "\n";
}

async function uploadAndWait(csvContent, token, label) {
  const dir = join(tmpdir(), "cw-integrity-test");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, FILE_NAME);
  writeFileSync(path, csvContent, "utf8");

  // 1. Create upload slot
  const buf = Buffer.from(csvContent, "utf8");
  const { gzipSync: gz } = await import("node:zlib");
  const { createHash: ch } = await import("node:crypto");
  const fileHash = ch("md5").update(buf).digest("hex");
  const compressed = gz(buf);

  const createRes = await fetch(`${BASE_URL}/api/v1/uploads`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ filename: FILE_NAME, sizeBytes: buf.length, fileHash, datasetId: DATASET_ID }),
  });
  const createBody = await createRes.json();
  if (!createRes.ok) throw new Error(`${label}: create upload failed ${createRes.status} — ${JSON.stringify(createBody)}`);
  const inner = createBody.data ?? createBody;
  // hash-skip: same file already imported
  if (inner.skip) { console.log(`  → SKIP (hash match)`); return inner.upload; }
  const uploadId = inner.upload?.id ?? inner.id;

  // 2. Upload file
  await fetch(`${BASE_URL}/api/v1/uploads/${uploadId}/file`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Encoding": "gzip", "Content-Type": "text/csv" },
    body: compressed,
  });

  // 3. Signal uploaded → triggers PREVIEW_UPLOAD
  await fetch(`${BASE_URL}/api/v1/uploads/${uploadId}/uploaded`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });

  // 4. Wait for AWAITING_CONFIRMATION
  let upload;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const r = await fetch(`${BASE_URL}/api/v1/uploads/${uploadId}`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await r.json();
    upload = body.data ?? body;
    if (upload.status === "AWAITING_CONFIRMATION") break;
  }
  if (upload.status !== "AWAITING_CONFIRMATION") throw new Error(`${label}: preview stuck at ${upload.status}`);

  const mapping = JSON.parse(upload.previewJson).columns;

  // 5. Confirm
  await fetch(`${BASE_URL}/api/v1/uploads/${uploadId}/confirm`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ datasetId: DATASET_ID, mode: "replace", mapping }),
  });

  // 6. Wait for COMPLETED or FAILED
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const r = await fetch(`${BASE_URL}/api/v1/uploads/${uploadId}`, { headers: { Authorization: `Bearer ${token}` } });
    const body2 = await r.json();
    upload = body2.data ?? body2;
    if (upload.status === "COMPLETED") return upload;
    if (upload.status === "FAILED") throw new Error(`${label}: import FAILED — ${upload.errorMessage}`);
  }
  throw new Error(`${label}: timed out at status=${upload.status}`);
}

async function queryTable(pool, schema) {
  const r = await pool.request().query(
    `SELECT id, nome, valor FROM ${schema}.[${TABLE}] ORDER BY id`
  );
  return r.recordset;
}

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ✔  ${message}`);
}

// ── main ─────────────────────────────────────────────────────────────────────

const token = await getToken();

// Get dataset schema from API
const dsRes = await fetch(`${BASE_URL}/api/v1/datasets/${DATASET_ID}`, {
  headers: { Authorization: `Bearer ${token}` },
});
const ds = await dsRes.json();
const schema = ds.data?.schemaName ?? ds.schemaName;
console.log(`Schema: ${schema}\n`);

// Parse CATWORLD_DATABASE_URL (format: sqlserver://host:port;database=x;user=y;password=z;...)
function parseSqlUrl(url) {
  const withoutScheme = url.replace(/^sqlserver:\/\//i, "");
  const [hostPort, ...rest] = withoutScheme.split(";").filter(Boolean);
  const [server, port] = hostPort.split(":");
  const params = Object.fromEntries(rest.map(p => { const i = p.indexOf("="); return [p.slice(0, i).toLowerCase(), p.slice(i + 1)]; }));
  return { server, port: port ? Number(port) : 1433, database: params.database, user: params.user, password: params.password,
    options: { encrypt: params.encrypt !== "false", trustServerCertificate: params.trustservercertificate === "true" },
    requestTimeout: 60000, connectionTimeout: 30000 };
}
const dbUrl = process.env.CATWORLD_DATABASE_URL || (() => { throw new Error("CATWORLD_DATABASE_URL not set") })();
const pool = await sql.connect(parseSqlUrl(dbUrl));

let rows, upload;

// ─────────────────────────────────────────────────────────────────────────────
console.log("═══ Scenario 1: Initial import (5 rows) ═══");
const v1 = [
  { id: 1, nome: "Alice", valor: 100 },
  { id: 2, nome: "Bob",   valor: 200 },
  { id: 3, nome: "Carol", valor: 300 },
  { id: 4, nome: "Dave",  valor: 400 },
  { id: 5, nome: "Eve",   valor: 500 },
];
await uploadAndWait(makeCsv(v1), token, "v1");
rows = await queryTable(pool, schema);
assert(rows.length === 5, `count=5 (got ${rows.length})`);
assert(rows.find(r => r.id == 1)?.nome === "Alice", "row 1 nome=Alice");
assert(rows.find(r => r.id == 5)?.nome === "Eve", "row 5 nome=Eve");

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n═══ Scenario 2: Add rows (5 → 8) ═══");
const v2 = [
  ...v1,
  { id: 6, nome: "Frank", valor: 600 },
  { id: 7, nome: "Grace", valor: 700 },
  { id: 8, nome: "Heidi", valor: 800 },
];
await uploadAndWait(makeCsv(v2), token, "v2");
rows = await queryTable(pool, schema);
assert(rows.length === 8, `count=8, not 13 (got ${rows.length})`);
assert(rows.find(r => r.id == 6)?.nome === "Frank", "new row 6 present");
assert(rows.find(r => r.id == 1)?.nome === "Alice", "old row 1 still present");

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n═══ Scenario 3: Remove rows + add new (8 → 6) ═══");
// Keep 1,2,3,6,7; remove 4,5,8; add 9
const v3 = [
  { id: 1, nome: "Alice", valor: 100 },
  { id: 2, nome: "Bob",   valor: 200 },
  { id: 3, nome: "Carol", valor: 300 },
  { id: 6, nome: "Frank", valor: 600 },
  { id: 7, nome: "Grace", valor: 700 },
  { id: 9, nome: "Ivan",  valor: 900 },
];
await uploadAndWait(makeCsv(v3), token, "v3");
rows = await queryTable(pool, schema);
assert(rows.length === 6, `count=6 (got ${rows.length})`);
assert(!rows.find(r => r.id == 4), "row 4 (Dave) removed");
assert(!rows.find(r => r.id == 5), "row 5 (Eve) removed");
assert(!rows.find(r => r.id == 8), "row 8 (Heidi) removed");
assert(rows.find(r => r.id == 9)?.nome === "Ivan", "new row 9 present");

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n═══ Scenario 4: Edit a field (Alice valor 100 → 999) ═══");
const v4 = v3.map(r => r.id === 1 ? { ...r, valor: 999 } : r);
await uploadAndWait(makeCsv(v4), token, "v4");
rows = await queryTable(pool, schema);
assert(rows.length === 6, `count still 6, no duplicate (got ${rows.length})`);
const alice = rows.find(r => r.id == 1);
assert(alice?.valor == 999 || alice?.valor == "999.0000", `Alice valor=999 (got ${alice?.valor})`);
assert(rows.filter(r => r.id == 1).length === 1, "no duplicate row for Alice");

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n═══ Scenario 5: No change (same file) ═══");
upload = await uploadAndWait(makeCsv(v4), token, "v5-nochange");
rows = await queryTable(pool, schema);
assert(rows.length === 6, `count still 6 after no-change (got ${rows.length})`);
assert(rows.find(r => r.id == 1)?.valor == 999 || rows.find(r => r.id == 1)?.valor == "999.0000", "Alice valor still 999");

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n═══ Scenario 6: Full replace — all rows different ═══");
const v6 = [
  { id: 10, nome: "Judy",  valor: 1000 },
  { id: 11, nome: "Karl",  valor: 1100 },
  { id: 12, nome: "Laura", valor: 1200 },
];
await uploadAndWait(makeCsv(v6), token, "v6");
rows = await queryTable(pool, schema);
assert(rows.length === 3, `count=3 (got ${rows.length})`);
assert(!rows.find(r => r.id == 1), "Alice (id=1) gone");
assert(!rows.find(r => r.id == 9), "Ivan (id=9) gone");
assert(rows.find(r => r.id == 10)?.nome === "Judy", "new row 10 (Judy) present");

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n═══ Cleanup ═══");
await pool.request().query(`DROP TABLE IF EXISTS ${schema}.[${TABLE}]`);
console.log(`  ✔  table ${TABLE} dropped`);

await pool.close();
console.log("\n✅  ALL SCENARIOS PASSED");
