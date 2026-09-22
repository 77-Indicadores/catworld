// @vitest-environment node
/**
 * refreshDatasetSource COMPLETO: fonte Postgres REAL (ERP falso = banco criado aqui) -> dataset cujo storage e o SQL Server REAL.
 * Carga inicial, incremental (delta) com linha alterada + nova, reconciliacao, ledger e o gate de integridade (0 linhas nao troca).
 * Prisma real (metadados no CW_TEST_PG_URL). So roda com CW_TEST_PG_URL + CW_TEST_MSSQL_URL (descartaveis; NUNCA producao).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mssqlUrl = process.env.CW_TEST_MSSQL_URL;
vi.hoisted(() => {
  if (process.env.CW_TEST_PG_URL) {
    process.env.CATWORLD_DATABASE_URL = process.env.CW_TEST_PG_URL;
    process.env.CATWORLD_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.AUTH_SECRET ||= "s".repeat(40);
  }
});

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import sql from "mssql";

const pgUrl = process.env.CW_TEST_PG_URL;
const enabled = !!mssqlUrl && !!pgUrl;
const d = enabled ? describe : describe.skip;
const SFX = randomUUID().replaceAll("-", "").slice(0, 10);
const ERP_DB = `cw_erpm_${SFX}`;
const SCHEMA = `srcm_${SFX}`;

function parseUrl(url: string): sql.config {
  const [hostPort, ...rest] = url.replace(/^sqlserver:\/\//i, "").split(";").filter(Boolean);
  const [server, port] = hostPort!.split(":");
  const p = Object.fromEntries(rest.map((x) => { const i = x.indexOf("="); return [x.slice(0, i).toLowerCase(), x.slice(i + 1)]; }));
  return { server: server!, port: port ? Number(port) : 1433, database: p.database, user: p.user, password: p.password,
    options: { encrypt: p.encrypt !== "false", trustServerCertificate: p.trustservercertificate === "true" }, requestTimeout: 120_000 };
}

d("refreshDatasetSource: Postgres -> SQL Server (real)", () => {
  let admin: Pool, erp: Pool, mssql: sql.ConnectionPool;
  let prisma: typeof import("@/server/db").prisma;
  let refreshDatasetSource: typeof import("./sources").refreshDatasetSource;
  let createDatasetSource: typeof import("./sources").createDatasetSource;
  let datasetId = "", connectionId = "";
  const q = (t: string) => `[${SCHEMA}].[${t}]`;
  const erpq = (s: string) => erp.query(s).then((r) => r.rows);
  const ms = async (s: string) => (await mssql.request().query(s)).recordset as Record<string, any>[];

  beforeAll(async () => {
    const u = new URL(pgUrl!);
    admin = new Pool({ connectionString: pgUrl });
    await admin.query(`CREATE DATABASE ${ERP_DB}`);
    const eu = new URL(pgUrl!); eu.pathname = `/${ERP_DB}`;
    erp = new Pool({ connectionString: eu.toString() });
    mssql = await new sql.ConnectionPool(parseUrl(mssqlUrl!)).connect();
    await mssql.request().query(`IF SCHEMA_ID('${SCHEMA}') IS NULL EXEC('CREATE SCHEMA ${SCHEMA}')`);

    ({ prisma } = await import("@/server/db"));
    ({ refreshDatasetSource, createDatasetSource } = await import("./sources"));
    const { encryptSecret } = await import("@/server/security/crypto");
    const serverId = randomUUID();
    await prisma.storageServer.create({ data: { id: serverId, name: `srcm-${SFX}`, provider: "sqlserver", url: mssqlUrl!, isDefault: false } });
    const proj = await prisma.project.create({ data: { name: "srcm", slug: `srcm-${SFX}` } });
    datasetId = (await prisma.dataset.create({ data: { projectId: proj.id, name: "srcm", slug: "srcm", schemaName: SCHEMA, storageServerId: serverId } })).id;
    connectionId = (await prisma.connection.create({ data: {
      name: `erp-${SFX}`, provider: "postgres", environment: "test", server: u.hostname, port: Number(u.port), databaseName: ERP_DB,
      sslMode: "disable", username: decodeURIComponent(u.username), encryptedCredentials: encryptSecret(JSON.stringify({ password: decodeURIComponent(u.password) })),
    } })).id;
  }, 120_000);
  afterAll(async () => {
    try {
      const tables = await mssql.request().query(`SELECT name FROM sys.tables WHERE schema_id = SCHEMA_ID('${SCHEMA}')`);
      for (const t of tables.recordset) await mssql.request().query(`DROP TABLE [${SCHEMA}].[${t.name}]`);
      await mssql.request().query(`DROP SCHEMA [${SCHEMA}]`);
    } catch { /* best-effort */ }
    await mssql?.close();
    await erp?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${ERP_DB} WITH (FORCE)`);
    await admin?.end();
  });

  const seed = `
    INSERT INTO public.vendas (id, upd, valor, grande, ts, nota) VALUES
     (1, '2026-03-01 10:00:00.123456+00', 12345678901234.123456, 9007199254740993, '2026-03-01 23:30:00.123456-03', 'ação ✓ 日本'),
     (2, '2026-03-01 10:01:00.000001+00', -0.000001,             -9223372036854775807, '2026-06-01 00:00:00.5+09', 'linha2'),
     (3, '2026-03-01 10:02:00+00',        99999999999999.999999, 9007199254740995, '2026-01-01 00:00:00+00', 'tres'),
     (4, '2026-03-01 10:03:00+00',        NULL,                  NULL,             NULL,                       NULL),
     (5, '2026-03-01 10:04:00+00',        1.5,                   7,                '2026-03-01 12:00:00.000123+00', 'cinco')`;

  const rowsMs = (t: string) => ms(`SELECT CAST(id AS NVARCHAR(30)) id, CAST(valor AS NVARCHAR(40)) valor, CAST(grande AS NVARCHAR(30)) grande,
      CONVERT(NVARCHAR(40), ts, 121) ts, nota FROM ${q(t)} ORDER BY TRY_CAST(id AS BIGINT)`);
  const cwIndexes = async (t: string) => Number((await ms(`SELECT COUNT(*) n FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id
      JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id WHERE i.object_id=OBJECT_ID(N'${SCHEMA}.${t}') AND c.name='cw_synced_at'`))[0]!.n);
  const ledger = (t: string) => prisma.$queryRawUnsafe<{ outcome: string; verdict: string }[]>(
    `SELECT outcome, verdict FROM cw_load_ledger WHERE dataset_id = $1::uuid AND table_name = $2 ORDER BY created_at`, datasetId, t);

  it("carga inicial, incremental (atualizada + nova) e reconciliacao: valores exatos no SQL Server, sem duplicar", async () => {
    await erpq(`CREATE TABLE public.vendas (id bigint PRIMARY KEY, upd timestamptz(6), valor numeric(20,6), grande bigint, ts timestamptz(6), nota text)`);
    await erpq(seed);
    const src = await createDatasetSource({ datasetId, connectionId, mode: "extract", sourceKind: "table", sourceSchema: "public", sourceTable: "vendas",
      keyColumn: "id", deltaColumn: "upd", refreshCron: "0 * * * *" }, { deferQueue: true });

    // ── carga inicial
    await refreshDatasetSource(src.id);
    let got = await rowsMs("vendas");
    expect(got).toHaveLength(5);
    expect(got[0]).toMatchObject({ id: "1", valor: "12345678901234.123456", grande: "9007199254740993", ts: "2026-03-02 02:30:00.1234560", nota: "ação ✓ 日本" });
    expect(got[1]).toMatchObject({ id: "2", valor: "-0.000001", grande: "-9223372036854775807", ts: "2026-05-31 15:00:00.5000000" });
    expect(got[2]).toMatchObject({ id: "3", valor: "99999999999999.999999", grande: "9007199254740995" });
    expect(got[3]).toMatchObject({ id: "4", valor: null, grande: null, ts: null, nota: null });
    expect(got[4]).toMatchObject({ id: "5", valor: "1.500000", grande: "7", ts: "2026-03-01 12:00:00.0001230" });
    const types = await ms(`SELECT c.name, t.name tn, c.precision, c.scale FROM sys.columns c JOIN sys.types t ON t.user_type_id=c.user_type_id WHERE c.object_id=OBJECT_ID(N'${SCHEMA}.vendas')`);
    const ty = Object.fromEntries(types.map((x) => [x.name, x]));
    expect(ty.valor).toMatchObject({ tn: "decimal", precision: 20, scale: 6 });
    expect(ty.grande.tn).toBe("bigint");
    expect(ty.ts.tn).toBe("datetime2");
    expect(await cwIndexes("vendas")).toBe(1);
    const fresh = await prisma.datasetSource.findUniqueOrThrow({ where: { id: src.id } });
    expect(fresh.lastStatus).toBe("completed");
    expect(fresh.lastDeltaValue).toBeTruthy();

    // ── incremental: linha 2 atualizada (delta avanca) + linhas novas 6 e 7
    await erpq(`UPDATE public.vendas SET valor = 777.777777, nota = 'atualizada', upd = '2026-03-01 11:00:00+00' WHERE id = 2`);
    await erpq(`INSERT INTO public.vendas VALUES (6, '2026-03-01 11:01:00+00', 0.000001, 9007199254740999, '2026-03-01 11:01:00.654321+00', 'seis'),
                                                 (7, '2026-03-01 11:02:00+00', 5, 1, NULL, 'sete')`);
    await refreshDatasetSource(src.id);
    got = await rowsMs("vendas");
    expect(got.map((r) => r.id)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(got[1]).toMatchObject({ valor: "777.777777", nota: "atualizada", grande: "-9223372036854775807" });
    expect(got[5]).toMatchObject({ valor: "0.000001", grande: "9007199254740999", ts: "2026-03-01 11:01:00.6543210" });
    expect(got[0]).toMatchObject({ valor: "12345678901234.123456", ts: "2026-03-02 02:30:00.1234560" });   // linha nao mexida segue exata
    expect(Number((await ms(`SELECT COUNT_BIG(DISTINCT id) n FROM ${q("vendas")}`))[0]!.n)).toBe(7);
    expect(await cwIndexes("vendas")).toBe(1);

    // ── reconciliacao: mudanca SEM avancar o delta (so a reconciliacao enxerga)
    await erpq(`UPDATE public.vendas SET valor = 3.333333 WHERE id = 3`);
    await refreshDatasetSource(src.id);
    expect((await rowsMs("vendas"))[2]!.valor).toBe("99999999999999.999999");   // o incremental nao ve
    await refreshDatasetSource(src.id, { reconciliation: true });
    got = await rowsMs("vendas");
    expect(got[2]!.valor).toBe("3.333333");
    expect(got).toHaveLength(7);
    expect(Number((await ms(`SELECT COUNT_BIG(DISTINCT id) n FROM ${q("vendas")}`))[0]!.n)).toBe(7);
    expect(await cwIndexes("vendas")).toBe(1);

    // oraculo: storage == ERP
    const erpRows = await erpq(`SELECT id::text id, valor::text valor, grande::text grande, nota FROM public.vendas ORDER BY id`);
    expect(got.map((r) => ({ id: r.id, valor: r.valor === null ? null : String(r.valor).replace(/\.?0+$/, ""), grande: r.grande, nota: r.nota })))
      .toEqual(erpRows.map((r) => ({ id: r.id, valor: r.valor === null ? null : String(r.valor).replace(/\.?0+$/, ""), grande: r.grande, nota: r.nota })));

    // ledger: uma linha por rodada (inicial, incremental, incremental, reconciliacao), todas concluidas
    const l = await ledger("vendas");
    expect(l.length).toBeGreaterThanOrEqual(4);
    expect(l.every((x) => x.outcome === "COMPLETED")).toBe(true);
  }, 300_000);

  it("gate de integridade: fonte que passa a devolver 0 linhas NAO troca a tabela (substituicao integral agendada)", async () => {
    await erpq(`CREATE TABLE public.itens (id bigint, nome text)`);
    await erpq(`INSERT INTO public.itens SELECT g, 'item ' || g FROM generate_series(1, 120) g`);
    const src = await createDatasetSource({ datasetId, connectionId, mode: "extract", sourceKind: "table", sourceSchema: "public", sourceTable: "itens",
      refreshCron: "0 * * * *" }, { deferQueue: true });   // sem chave/delta: cada rodada e substituicao integral
    await refreshDatasetSource(src.id);
    expect(Number((await ms(`SELECT COUNT_BIG(*) n FROM ${q("itens")}`))[0]!.n)).toBe(120);

    await erpq(`DELETE FROM public.itens`);
    await expect(refreshDatasetSource(src.id)).rejects.toThrow(/\[integrity\].*EMPTY_REPLACE/);
    expect(Number((await ms(`SELECT COUNT_BIG(*) n FROM ${q("itens")}`))[0]!.n)).toBe(120);
    const fresh = await prisma.datasetSource.findUniqueOrThrow({ where: { id: src.id } });
    expect(fresh.lastStatus).toBe("failed");
    expect(fresh.lastError).toMatch(/A tabela anterior foi mantida/);
    const l = await ledger("itens");
    expect(l.map((x) => x.outcome)).toEqual(["COMPLETED", "FAILED"]);
    expect(await cwIndexes("itens")).toBeLessThanOrEqual(1);
  }, 300_000);
});
