// @vitest-environment node
/**
 * CRASH TEST (SQL Server real): o import roda num processo FILHO que morre com kill -9 (taskkill /F /T) no meio da carga da staging.
 * Garante: a tabela destino segue na versão anterior completa (nunca parcial), a staging parcial não é reaproveitada e a
 * retentativa do MESMO upload entrega exatamente as linhas do arquivo, uma vez só (replace, append e delta-replace).
 * Só roda com CW_TEST_MSSQL_URL + CW_TEST_PG_URL (bancos descartáveis).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mssqlUrl = process.env.CW_TEST_MSSQL_URL;
vi.hoisted(() => {
  if (process.env.CW_TEST_PG_URL) {
    process.env.CATWORLD_DATABASE_URL = process.env.CW_TEST_PG_URL;
    process.env.CATWORLD_ENCRYPTION_KEY ||= "k".repeat(32);
    process.env.AUTH_SECRET ||= "s".repeat(40);
  }
});

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import sql from "mssql";

const enabled = !!mssqlUrl && !!process.env.CW_TEST_PG_URL;
const d = enabled ? describe : describe.skip;
const SCHEMA = `crash_${Date.now().toString(36)}`;
const N = 400_000;

function parseUrl(url: string): sql.config {
  const [hostPort, ...rest] = url.replace(/^sqlserver:\/\//i, "").split(";").filter(Boolean);
  const [server, port] = hostPort!.split(":");
  const p = Object.fromEntries(rest.map((x) => { const i = x.indexOf("="); return [x.slice(0, i).toLowerCase(), x.slice(i + 1)]; }));
  return { server: server!, port: port ? Number(port) : 1433, database: p.database, user: p.user, password: p.password,
    options: { encrypt: p.encrypt !== "false", trustServerCertificate: p.trustservercertificate === "true" }, requestTimeout: 120_000 };
}

d("crash do processo no meio do import (SQL Server real)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cw-crash-"));
  let pool: sql.ConnectionPool;
  let prisma: typeof import("@/server/db").prisma;
  let importUpload: typeof import("./importer").importUpload;
  let previewFile: typeof import("./parser").previewFile;
  let datasetId = "";
  const q = (t: string) => `[${SCHEMA}].[${t}]`;

  beforeAll(async () => {
    pool = await new sql.ConnectionPool(parseUrl(mssqlUrl!)).connect();
    ({ prisma } = await import("@/server/db"));
    ({ importUpload } = await import("./importer"));
    ({ previewFile } = await import("./parser"));
    const serverId = randomUUID();
    await prisma.storageServer.create({ data: { id: serverId, name: `crash-${SCHEMA}`, provider: "sqlserver", url: mssqlUrl!, isDefault: false } });
    const proj = await prisma.project.create({ data: { name: "crash", slug: `crash-${SCHEMA}` } });
    datasetId = (await prisma.dataset.create({ data: { projectId: proj.id, name: "crash", slug: "crash", schemaName: SCHEMA, storageServerId: serverId } })).id;
    await pool.request().query(`IF SCHEMA_ID('${SCHEMA}') IS NULL EXEC('CREATE SCHEMA ${SCHEMA}')`);
  });
  afterAll(async () => {
    try {
      const tables = await pool.request().query(`SELECT name FROM sys.tables WHERE schema_id = SCHEMA_ID('${SCHEMA}')`);
      for (const t of tables.recordset) await pool.request().query(`DROP TABLE [${SCHEMA}].[${t.name}]`);
      await pool.request().query(`DROP SCHEMA [${SCHEMA}]`);
    } catch { /* best-effort */ }
    await pool?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function file(name: string, n: number, tag: string, from = 1): Promise<string> {
    const p = join(dir, name);
    const ws = createWriteStream(p);
    ws.write("id,nome,valor\n");
    for (let i = from; i < from + n; i++) {
      if (!ws.write(`${i},${tag} ${i} ${"x".repeat(40)},${i}.5\n`)) await new Promise((r) => ws.once("drain", r));
    }
    await new Promise<void>((r) => ws.end(r));
    return p;
  }

  async function makeUpload(path: string, table: string, mode: "replace" | "append", id = randomUUID()) {
    const prev = await previewFile(path);
    await prisma.upload.create({ data: {
      id, datasetId, originalFilename: `${table}.csv`, blobName: `crash/${id}.csv`, sizeBytes: 1n, mode, status: "IMPORTING",
      rowCount: BigInt(prev.rowCount), previewJson: JSON.stringify({ ...prev, source: "server" }), mappingJson: JSON.stringify(prev.columns),
    } });
    return id;
  }

  const count = async (t: string) => Number((await pool.request().query(`SELECT COUNT_BIG(*) n FROM ${q(t)}`)).recordset[0].n);
  const distinct = async (t: string) => Number((await pool.request().query(`SELECT COUNT_BIG(DISTINCT id) n FROM ${q(t)}`)).recordset[0].n);
  const stageCount = async (id: string) => {
    const stage = `cw_stage_${id.replaceAll("-", "").slice(0, 20)}`;
    const r = await pool.request().query(`SELECT OBJECT_ID(N'${SCHEMA}.${stage}', N'U') oid`);
    if (r.recordset[0].oid == null) return -1;
    return Number((await pool.request().query(`SELECT COUNT_BIG(*) n FROM ${q(stage)} WITH (NOLOCK)`)).recordset[0].n);
  };

  /** Sobe o filho, espera a staging ter linhas (mas não todas) e o mata com kill -9. Devolve quantas linhas a staging tinha. */
  async function crashMidLoad(id: string, path: string): Promise<number> {
    const child: ChildProcess = spawn("npx", ["tsx", "src/server/uploads/importer-crash-child.ts", id, path], { shell: true, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; child.stdout?.on("data", (b) => { out += b; }); child.stderr?.on("data", (b) => { out += b; });
    let exited = false; child.on("exit", () => { exited = true; });
    const deadline = Date.now() + 150_000;
    let seen = 0;
    while (Date.now() < deadline && !exited) {
      seen = await stageCount(id).catch(() => -1);
      if (seen > 0 && seen < N) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (exited || !(seen > 0 && seen < N)) throw new Error(`nao consegui pegar o filho no meio da carga (staging=${seen}, exited=${exited}): ${out.slice(-800)}`);
    execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 1500));
    return seen;
  }
  /** o lease do lock morre junto com o dono; expira agora para nao esperar os 120s (o dono esta morto: e exatamente o que o lease faz). */
  const expireLock = () => prisma.$executeRawUnsafe(`UPDATE cw_import_locks SET expires_at = now() - interval '1 second' WHERE lock_key LIKE $1`, `${datasetId}:%`);

  for (const scenario of ["replace", "append", "delta-replace"] as const) {
    it(`${scenario}: kill -9 no meio da carga preserva a versao anterior; a retentativa entrega o arquivo exato, uma vez`, async () => {
      const table = `t_${scenario.replace("-", "_")}`;
      if (scenario === "replace") {
        // tabela anterior SEM _cw_rh: o replace vira full-replace (troca atomica da tabela inteira)
        await pool.request().query(`CREATE TABLE ${q(table)} (id BIGINT NULL, nome NVARCHAR(MAX) NULL, valor DECIMAL(18,4) NULL)`);
        await pool.request().query(`INSERT INTO ${q(table)} (id, nome, valor) SELECT TOP 2000 ROW_NUMBER() OVER (ORDER BY (SELECT 1)), 'v1 ' + CAST(ROW_NUMBER() OVER (ORDER BY (SELECT 1)) AS varchar(10)) + ' ' + REPLICATE('x',40), ROW_NUMBER() OVER (ORDER BY (SELECT 1)) + 0.5 FROM sys.all_objects a CROSS JOIN sys.all_objects b`);
      } else {
        const base = await file(`${table}_base.csv`, 2000, "v1");
        await importUpload(await makeUpload(base, table, "replace"), base);
      }
      expect(await count(table)).toBe(2000);

      const from = scenario === "append" ? 2001 : 1;
      const big = await file(`${table}_big.csv`, N, "v2", from);
      const id = await makeUpload(big, table, scenario === "append" ? "append" : "replace");
      const seen = await crashMidLoad(id, big);
      expect(seen).toBeGreaterThan(0); expect(seen).toBeLessThan(N);

      // tabela intacta: mesma versao anterior, completa, sem nenhuma linha do arquivo novo
      expect(await count(table)).toBe(2000);
      expect(await distinct(table)).toBe(2000);
      expect(Number((await pool.request().query(`SELECT COUNT_BIG(*) n FROM ${q(table)} WHERE nome LIKE 'v2 %'`)).recordset[0].n)).toBe(0);
      expect(await stageCount(id)).toBeGreaterThanOrEqual(0);   // a staging do processo morto ficou (vazia: o SQL Server desfez a carga nao confirmada; nunca publicada)

      await expireLock();
      await importUpload(id, big);   // retentativa do MESMO upload

      const expected = scenario === "append" ? 2000 + N : N;
      expect(await count(table)).toBe(expected);
      expect(await distinct(table)).toBe(expected);
      const r = (await pool.request().query(`SELECT MIN(CAST(id AS BIGINT)) mn, MAX(CAST(id AS BIGINT)) mx FROM ${q(table)}`)).recordset[0];
      expect([Number(r.mn), Number(r.mx)]).toEqual([1, scenario === "append" ? 2000 + N : N]);
      expect(Number((await pool.request().query(`SELECT COUNT_BIG(*) n FROM ${q(table)} WHERE nome LIKE 'v1 %'`)).recordset[0].n)).toBe(scenario === "append" ? 2000 : 0);
      expect(await stageCount(id)).toBe(-1);   // staging parcial descartada, nao reaproveitada
      if (scenario === "append") {
        expect((await pool.request().query(`SELECT COUNT(*) n FROM cw_internal.applied_uploads WHERE upload_id = '${id}'`)).recordset[0].n).toBe(1);
        await importUpload(id, big);           // reexecucao apos o sucesso: nao duplica
        expect(await count(table)).toBe(expected);
      }
    }, 600_000);
  }
});
