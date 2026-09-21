// @vitest-environment node
/**
 * Confiabilidade do import para SQL SERVER (atomicidade, integridade, fidelidade de valores), pelo `importUpload` de verdade.
 *
 * Só roda com CW_TEST_MSSQL_URL (SQL Server DESCARTÁVEL; formato do Catworld:
 *   sqlserver://host:1433;database=cw_test;user=sa;password=...;encrypt=true;trustServerCertificate=true)
 * E com CW_TEST_PG_URL (Postgres descartável com o schema do Catworld: é o banco de METADADOS). NUNCA produção.
 * O teste cria um banco/schema `rel_*` no SQL Server e apaga no fim.
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

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import sql from "mssql";

const enabled = !!mssqlUrl && !!process.env.CW_TEST_PG_URL;
const d = enabled ? describe : describe.skip;
const SCHEMA = `rel_${Date.now().toString(36)}`;

function parseUrl(url: string): sql.config {
  const [hostPort, ...rest] = url.replace(/^sqlserver:\/\//i, "").split(";").filter(Boolean);
  const [server, port] = hostPort!.split(":");
  const p = Object.fromEntries(rest.map((x) => { const i = x.indexOf("="); return [x.slice(0, i).toLowerCase(), x.slice(i + 1)]; }));
  return { server: server!, port: port ? Number(port) : 1433, database: p.database, user: p.user, password: p.password,
    options: { encrypt: p.encrypt !== "false", trustServerCertificate: p.trustservercertificate === "true" }, requestTimeout: 120_000 };
}

d("import SQL Server: atomicidade, integridade e fidelidade (real)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cw-mssql-"));
  let pool: sql.ConnectionPool;
  let prisma: typeof import("@/server/db").prisma;
  let importUpload: typeof import("./importer").importUpload;
  let previewFile: typeof import("./parser").previewFile;
  let datasetId = "";

  beforeAll(async () => {
    pool = await new sql.ConnectionPool(parseUrl(mssqlUrl!)).connect();
    ({ prisma } = await import("@/server/db"));
    ({ importUpload } = await import("./importer"));
    ({ previewFile } = await import("./parser"));
    const serverId = randomUUID();
    await prisma.storageServer.create({ data: { id: serverId, name: `rel-${SCHEMA}`, provider: "sqlserver", url: mssqlUrl!, isDefault: false } });
    const proj = await prisma.project.create({ data: { name: "rel", slug: `rel-${SCHEMA}` } });
    datasetId = (await prisma.dataset.create({ data: { projectId: proj.id, name: "rel", slug: "rel", schemaName: SCHEMA, storageServerId: serverId } })).id;
    await pool.request().query(`IF SCHEMA_ID('${SCHEMA}') IS NULL EXEC('CREATE SCHEMA ${SCHEMA}')`);
  });
  afterAll(async () => {
    try {
      const tables = await pool.request().query(`SELECT name FROM sys.tables WHERE schema_id = SCHEMA_ID('${SCHEMA}')`);
      for (const t of tables.recordset) await pool.request().query(`DROP TABLE [${SCHEMA}].[${t.name}]`);
      await pool.request().query(`DROP SCHEMA [${SCHEMA}]`);
    } catch { /* limpeza best-effort */ }
    await pool?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function file(name: string, n: number, tag = "v1", from = 1, row?: (i: number) => string) {
    const lines = ["id,nome,valor"];
    for (let i = from; i < from + n; i++) lines.push(row ? row(i) : `${i},${tag} ${i},${i}.5`);
    const p = join(dir, name);
    writeFileSync(p, lines.join("\n") + "\n");
    return p;
  }

  async function run(path: string, table: string, mode: "replace" | "append" | "upsert" = "replace", keyColumn?: string,
    opts: { rowCount?: number; id?: string; fullSnapshot?: boolean } = {}) {
    const prev = await previewFile(path);
    const id = opts.id ?? randomUUID();
    if (!(await prisma.upload.findUnique({ where: { id } }))) {
      await prisma.upload.create({ data: {
        id, datasetId, originalFilename: `${table}.csv`, blobName: `rel/${id}.csv`, sizeBytes: 1n, mode, keyColumn: keyColumn ?? null,
        fullSnapshot: opts.fullSnapshot ?? false, status: "IMPORTING", rowCount: BigInt(opts.rowCount ?? prev.rowCount),
        previewJson: JSON.stringify(prev), mappingJson: JSON.stringify(prev.columns),
      } });
    }
    return importUpload(id, path);
  }

  const q = (t: string) => `[${SCHEMA}].[${t}]`;
  const count = async (t: string) => Number((await pool.request().query(`SELECT COUNT_BIG(*) n FROM ${q(t)}`)).recordset[0].n);
  const rows = async (t: string) => (await pool.request().query(`SELECT id, nome, valor FROM ${q(t)} ORDER BY TRY_CAST(id AS BIGINT)`)).recordset as { id: unknown; nome: string; valor: unknown }[];
  const expectRows = (got: { id: unknown; nome: string; valor: unknown }[], n: number, tag: string, from = 1) => {
    expect(got.length).toBe(n);
    for (let k = 0; k < n; k++) {
      const i = from + k;
      if (String(got[k]!.id) !== String(i) || got[k]!.nome !== `${tag} ${i}` || Number(got[k]!.valor) !== i + 0.5) throw new Error(`linha ${k}: esperado ${i}|${tag} ${i}|${i}.5, veio ${got[k]!.id}|${got[k]!.nome}|${got[k]!.valor}`);
    }
  };

  it("replace novo e replace sobre tabela existente (delta-replace): conteúdo exato", async () => {
    await run(file("a1.csv", 3000, "v1"), "t_replace");
    expectRows(await rows("t_replace"), 3000, "v1");
    await run(file("a2.csv", 4500, "v2"), "t_replace");
    expectRows(await rows("t_replace"), 4500, "v2");
  }, 120_000);

  it("INTEGRIDADE: menos linhas que o esperado NÃO troca a tabela e não deixa staging", async () => {
    await run(file("b1.csv", 2000, "v1"), "t_integ");
    await expect(run(file("b2.csv", 800, "v2"), "t_integ", "replace", undefined, { rowCount: 3000 })).rejects.toThrow(/\[integrity\] ROWS_BELOW_EXPECTED/);
    expectRows(await rows("t_integ"), 2000, "v1");
    const stages = (await pool.request().query(`SELECT COUNT(*) n FROM sys.tables WHERE schema_id = SCHEMA_ID('${SCHEMA}') AND name LIKE 'cw_stage_%'`)).recordset[0].n;
    expect(stages).toBe(0);
  }, 120_000);

  it("INTEGRIDADE: substituir tabela com dados por arquivo só com cabeçalho é barrado", async () => {
    await run(file("c1.csv", 300, "v1"), "t_empty");
    await expect(run(file("c2.csv", 0, "v2"), "t_empty")).rejects.toThrow(/EMPTY_REPLACE/);
    expect(await count("t_empty")).toBe(300);
  }, 120_000);

  it("EXACTLY-ONCE: append reexecutado com o mesmo upload não duplica", async () => {
    await run(file("d1.csv", 1000, "v1"), "t_once");
    const id = randomUUID(); const f = file("d2.csv", 500, "v2", 1001);
    await run(f, "t_once", "append", undefined, { id });
    expect(await count("t_once")).toBe(1500);
    await run(f, "t_once", "append", undefined, { id });
    expect(await count("t_once")).toBe(1500);
    const marker = (await pool.request().query(`SELECT COUNT(*) n FROM cw_internal.applied_uploads WHERE upload_id = '${id}'`)).recordset[0].n;
    expect(marker).toBe(1);
    await run(f, "t_once", "append");                 // upload novo, mesmo arquivo: é outra carga
    expect(await count("t_once")).toBe(2000);
  }, 120_000);

  it("TIPOS: append não estreita a coluna (decimais em tabela inteira são recusados)", async () => {
    const ints = join(dir, "e1.csv"); writeFileSync(ints, "id,nome,valor\n1,a,10\n2,b,20\n");
    await run(ints, "t_narrow");
    const decimals = join(dir, "e2.csv"); writeFileSync(decimals, "id,nome,valor\n3,c,1.6\n4,d,2.4\n");
    await expect(run(decimals, "t_narrow", "append")).rejects.toThrow(/Tipos incompatíveis|Schema incompatível/);
    expect(await count("t_narrow")).toBe(2);
  }, 120_000);

  it("UPSERT: atualiza, insere e é idempotente; chave nula é recusada", async () => {
    await run(file("f1.csv", 2000, "v1"), "t_upsert");
    await run(file("f2.csv", 1500, "v2", 1501), "t_upsert", "upsert", "id");
    expect(await count("t_upsert")).toBe(3000);
    const got = await rows("t_upsert");
    expect(got.filter((r) => r.nome.startsWith("v1 ")).length).toBe(1500);
    expect(got.filter((r) => r.nome.startsWith("v2 ")).length).toBe(1500);
    await run(file("f3.csv", 1500, "v2", 1501), "t_upsert", "upsert", "id");
    expect(await count("t_upsert")).toBe(3000);
    const bad = join(dir, "f4.csv"); writeFileSync(bad, "id,nome,valor\n5,x,1.5\n,sem chave,2.5\n");
    await expect(run(bad, "t_upsert", "upsert", "id")).rejects.toThrow(/chave nula/);
    expect(await count("t_upsert")).toBe(3000);
  }, 180_000);

  it("FIDELIDADE: BIGINT negativo e acima de 2^53, decimais exatos, texto unicode e nulos", async () => {
    const p = join(dir, "g1.csv");
    writeFileSync(p, [
      "id,big,dec,txt,quando",
      "1,-1,0.0001,ação ✓ 日本,2023-01-15 08:30:00",
      "2,9007199254740993,12345678901234.5678,\"linha1\nlinha2\",2023-12-31 23:59:59",
      "3,-9223372036854775807,-99999999999999.9999,x,",
      "4,,,,",
    ].join("\n") + "\n");
    await run(p, "t_fidel");
    const r = (await pool.request().query(`SELECT id, big, CAST(dec AS NVARCHAR(40)) dec, txt, CONVERT(NVARCHAR(30), quando, 126) quando FROM ${q("t_fidel")} ORDER BY id`)).recordset;
    expect(r.map((x) => String(x.big))).toEqual(["-1", "9007199254740993", "-9223372036854775807", "null"]);
    expect(r.map((x) => x.dec)).toEqual(["0.0001", "12345678901234.5678", "-99999999999999.9999", null]);
    expect(r[0].txt).toBe("ação ✓ 日本");
    expect(r[1].txt).toBe("linha1\nlinha2");
    expect(r[0].quando).toBe("2023-01-15T08:30:00");        // sem deslocamento de fuso
    expect(r[1].quando).toBe("2023-12-31T23:59:59");
    expect(r[3].quando).toBeNull();
  }, 120_000);

  it("um leitor concorrente nunca vê tabela vazia ou parcial durante um replace", async () => {
    await run(file("h1.csv", 5000, "v1"), "t_reader");
    const seen = new Set<number>(); let stop = false;
    const reader = (async () => {
      while (!stop) {
        try { seen.add(await count("t_reader")); } catch { /* troca em andamento */ }
        await new Promise((r) => setTimeout(r, 20));
      }
    })();
    await run(file("h2.csv", 20_000, "v2"), "t_reader");
    stop = true; await reader;
    expect([...seen].filter((n) => n !== 5000 && n !== 20_000)).toEqual([]);
    expect(await count("t_reader")).toBe(20_000);
  }, 240_000);

  it("a retentativa NÃO reaproveita staging parcial: reimporta e entrega o arquivo inteiro (incidente da ADL)", async () => {
    await run(file("i1.csv", 1000, "v1"), "t_retry");
    // simula a sobra de uma tentativa que morreu no meio: staging do MESMO upload com só parte das linhas
    const id = randomUUID();
    const stage = `cw_stage_${id.replaceAll("-", "").slice(0, 20)}`;
    await pool.request().query(`CREATE TABLE ${q(stage)} (id BIGINT NULL, nome NVARCHAR(MAX) NULL, valor DECIMAL(18,4) NULL, _cw_rh CHAR(32) NULL)`);
    await pool.request().query(`INSERT INTO ${q(stage)} (id, nome, valor) SELECT TOP 50 ROW_NUMBER() OVER (ORDER BY (SELECT 1)), 'parcial', 1 FROM sys.all_objects`);
    await run(file("i2.csv", 4000, "v2"), "t_retry", "replace", undefined, { id });
    expectRows(await rows("t_retry"), 4000, "v2");           // antes: publicava as 50 linhas parciais
  }, 180_000);

  it("LEDGER: cada tentativa fica registrada com o veredito", async () => {
    const r = (await prisma.$queryRawUnsafe<{ outcome: string; verdict: string }[]>(
      `SELECT outcome, verdict FROM cw_load_ledger WHERE dataset_id = $1::uuid AND table_name = 't_integ' ORDER BY created_at`, datasetId));
    expect(r.map((x) => [x.outcome, x.verdict])).toEqual([["COMPLETED", "OK"], ["FAILED", "FAILED"]]);
  });
});
