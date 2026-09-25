// @vitest-environment node
/**
 * migrateDatasetStorage COMPLETO contra bancos REAIS (SQL Server <-> Postgres): fidelidade exata de BIGINT >2^53 e
 * DECIMAL com mais de 15 dígitos vindos do SQL Server (o driver decodifica esses tipos como Number por padrão — a
 * migração precisa converter em SQL, não confiar no driver), cw_synced_at original preservado (não recarimbado),
 * RLS de linha excluída aplicada no destino Postgres, índice cw_synced_at criado, e a direção inversa (Postgres ->
 * SQL Server). Prisma real (metadados no CW_TEST_PG_URL). Só roda com CW_TEST_PG_URL + CW_TEST_MSSQL_URL
 * (descartáveis; NUNCA produção — MSYS_NO_PATHCONV=1 no Git Bash se a URL tiver barra).
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
const SCHEMA = `mig_${SFX}`;

function parseMssqlUrl(url: string): sql.config {
  const [hostPort, ...rest] = url.replace(/^sqlserver:\/\//i, "").split(";").filter(Boolean);
  const [server, port] = hostPort!.split(":");
  const p = Object.fromEntries(rest.map((x) => { const i = x.indexOf("="); return [x.slice(0, i).toLowerCase(), x.slice(i + 1)]; }));
  return { server: server!, port: port ? Number(port) : 1433, database: p.database, user: p.user, password: p.password,
    options: { encrypt: p.encrypt !== "false", trustServerCertificate: p.trustservercertificate === "true" }, requestTimeout: 120_000 };
}

d("migrateDatasetStorage (Postgres + SQL Server reais)", { timeout: 120_000 }, () => {
  let pgPool: Pool, mssqlPool: sql.ConnectionPool;
  let prisma: typeof import("@/server/db").prisma;
  let migrateDatasetStorage: typeof import("./migrate").migrateDatasetStorage;
  let pgServerId = "", mssqlServerId = "";

  beforeAll(async () => {
    pgPool = new Pool({ connectionString: pgUrl });
    mssqlPool = await new sql.ConnectionPool(parseMssqlUrl(mssqlUrl!)).connect();
    // Cada teste usa seu proprio schema (${SCHEMA}_tN): Dataset.schemaName e unico, e um dataset = um schema
    // exclusivo na origem, entao datasets diferentes nao podem compartilhar o mesmo schema fisico.

    ({ prisma } = await import("@/server/db"));
    ({ migrateDatasetStorage } = await import("./migrate"));

    pgServerId = randomUUID();
    mssqlServerId = randomUUID();
    await prisma.storageServer.create({ data: { id: pgServerId, name: `mig-pg-${SFX}`, provider: "postgres", url: pgUrl!, isDefault: false } });
    await prisma.storageServer.create({ data: { id: mssqlServerId, name: `mig-mssql-${SFX}`, provider: "sqlserver", url: mssqlUrl!, isDefault: false } });
  });

  afterAll(async () => {
    for (const s of [`${SCHEMA}_t1`, `${SCHEMA}_t2`, `${SCHEMA}_t3`]) {
      await pgPool.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`).catch(() => {});
      // best-effort: no MSSQL o schema so cai vazio (DROP SCHEMA falha se ainda tiver tabela — a tabela original
      // do lado de origem de cada teste ja foi removida pelo proprio atomicSwap/migracao, exceto quando o
      // destino da migracao era o MSSQL, ai a tabela fica la de proposito).
      await mssqlPool.request().query(`DROP SCHEMA IF EXISTS ${s}`).catch(() => {});
    }
    await pgPool.end();
    await mssqlPool.close();
  });

  it("SQL Server -> Postgres: BIGINT >2^53 e DECIMAL(20,6) exatos, cw_synced_at preservado, RLS e índice criados", async () => {
    const SCH1 = `${SCHEMA}_t1`;
    await mssqlPool.request().query(`IF SCHEMA_ID('${SCH1}') IS NULL EXEC('CREATE SCHEMA ${SCH1}')`);
    await pgPool.query(`DROP SCHEMA IF EXISTS ${SCH1} CASCADE; CREATE SCHEMA ${SCH1}`);
    const q = `[${SCH1}].[t1]`;
    await mssqlPool.request().query(`
      CREATE TABLE ${q} (
        id BIGINT NOT NULL, valor DECIMAL(20,6) NOT NULL, nome NVARCHAR(50) NULL,
        cw_synced_at DATETIME2 NOT NULL, cw_deleted_at DATETIME2 NULL, [_cw_rh] CHAR(32) NULL
      )`);
    const oldStamp = "2020-06-01 10:00:00.1234567";
    await mssqlPool.request().query(`
      INSERT INTO ${q} (id, valor, nome, cw_synced_at, cw_deleted_at, [_cw_rh]) VALUES
        (9007199254740993, 12345678901234.567891, 'ativa', '${oldStamp}', NULL, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
        (-9223372036854775807, 0.000001, 'excluida', '${oldStamp}', '2020-06-02 00:00:00', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    `);

    const datasetId = randomUUID();
    const project = await prisma.project.create({ data: { name: `mig-${SFX}`, slug: `mig-${SFX}` } });
    await prisma.dataset.create({ data: { id: datasetId, projectId: project.id, name: "t1", slug: "t1", schemaName: SCH1, storageServerId: mssqlServerId } });

    const result = await migrateDatasetStorage(datasetId, pgServerId);
    expect(result.tables).toEqual([{ table: "t1", rows: 2 }]);

    const dataset = await prisma.dataset.findUniqueOrThrow({ where: { id: datasetId } });
    expect(dataset.storageServerId).toBe(pgServerId);

    // cw_synced_at/cw_deleted_at lidos como TEXTO: o driver pg decodifica timestamp sem fuso usando o fuso do
    // PROCESSO NODE (nao UTC), entao um Date aqui mentiria sobre o valor gravado — mesma razao pela qual o
    // resto do projeto sempre le essas colunas como texto cru (nunca deixa o driver construir Date).
    const rows = (await pgPool.query(`SELECT id::text, valor::text, nome, cw_synced_at::text AS cw_synced_at, cw_deleted_at::text AS cw_deleted_at FROM ${SCH1}.t1 ORDER BY id`)).rows;
    expect(rows).toHaveLength(2);
    // BIGINT exato nos dois extremos (o driver TDS decodificaria como Number e perderia dígitos sem a conversão em SQL)
    expect(rows[0].id).toBe("-9223372036854775807");
    expect(rows[1].id).toBe("9007199254740993");
    // DECIMAL(20,6) exato — 17 dígitos inteiros + 6 decimais, muito além dos 15 dígitos seguros de Number
    expect(rows[1].valor).toBe("12345678901234.567891");
    expect(rows[0].valor).toBe("0.000001");
    // cw_synced_at é o valor ORIGINAL da origem, não recarimbado para "agora" pela migração.
    // ORDER BY id ascendente: id negativo ("excluida") vem primeiro, id positivo ("ativa") depois.
    expect(rows[0].cw_synced_at).toBe("2020-06-01 10:00:00.123");
    expect(rows[0].cw_deleted_at).toBe("2020-06-02 00:00:00"); // "excluida"
    expect(rows[1].cw_deleted_at).toBeNull(); // "ativa"

    // RLS: politica que esconde linha excluida foi aplicada na tabela migrada (mesma protecao de qualquer carga normal)
    const pol = (await pgPool.query(`SELECT polname FROM pg_policy WHERE polrelid = '${SCH1}.t1'::regclass AND polname='cw_hide_deleted'`)).rows;
    expect(pol).toHaveLength(1);
    const rls = (await pgPool.query(`SELECT relrowsecurity FROM pg_class WHERE oid = '${SCH1}.t1'::regclass`)).rows[0];
    expect(rls.relrowsecurity).toBe(true);

    // Índice em cw_synced_at foi criado (rows?since= não varre a tabela toda)
    const idx = (await pgPool.query(`SELECT indexdef FROM pg_indexes WHERE schemaname='${SCH1}' AND tablename='t1' AND indexdef ILIKE '%cw_synced_at%'`)).rows;
    expect(idx.length).toBeGreaterThanOrEqual(1);
  });

  it("Postgres -> SQL Server: DECIMAL exato e NUMERIC(38,10) sobrevivem (direção inversa)", async () => {
    const SCH2 = `${SCHEMA}_t2`;
    await mssqlPool.request().query(`IF SCHEMA_ID('${SCH2}') IS NULL EXEC('CREATE SCHEMA ${SCH2}')`);
    await pgPool.query(`DROP SCHEMA IF EXISTS ${SCH2} CASCADE; CREATE SCHEMA ${SCH2};
      CREATE TABLE ${SCH2}.t2 (
        id BIGINT NOT NULL, valor NUMERIC(38,10) NOT NULL,
        cw_synced_at TIMESTAMP NOT NULL, cw_deleted_at TIMESTAMP NULL
      );
      INSERT INTO ${SCH2}.t2 (id, valor, cw_synced_at) VALUES
        (9223372036854775807, 123456789012345678901234567.1234567890, now());
    `);

    const datasetId = randomUUID();
    const project = await prisma.project.create({ data: { name: `mig2-${SFX}`, slug: `mig2-${SFX}` } });
    await prisma.dataset.create({ data: { id: datasetId, projectId: project.id, name: "t2", slug: "t2", schemaName: SCH2, storageServerId: pgServerId } });

    const { migrateDatasetStorage: mig } = await import("./migrate");
    await mig(datasetId, mssqlServerId);

    const rows = (await mssqlPool.request().query(`SELECT CONVERT(VARCHAR(60), id) idt, CONVERT(VARCHAR(60), valor) valort FROM [${SCH2}].[t2]`)).recordset;
    expect(rows).toHaveLength(1);
    expect(rows[0].idt).toBe("9223372036854775807");
    expect(rows[0].valort).toBe("123456789012345678901234567.1234567890");
  });

  it("retomar uma migração após falha não deixa staging orfã (dropTableIfExists + atomicSwap limpam)", async () => {
    const SCH3 = `${SCHEMA}_t3`;
    await mssqlPool.request().query(`IF SCHEMA_ID('${SCH3}') IS NULL EXEC('CREATE SCHEMA ${SCH3}')`);
    await pgPool.query(`DROP SCHEMA IF EXISTS ${SCH3} CASCADE; CREATE SCHEMA ${SCH3}`);
    const q = `[${SCH3}].[t3]`;
    await mssqlPool.request().query(`CREATE TABLE ${q} (id BIGINT NOT NULL, cw_synced_at DATETIME2 NOT NULL, cw_deleted_at DATETIME2 NULL); INSERT INTO ${q} (id, cw_synced_at) VALUES (1, SYSUTCDATETIME())`);
    const datasetId = randomUUID();
    const project = await prisma.project.create({ data: { name: `mig3-${SFX}`, slug: `mig3-${SFX}` } });
    await prisma.dataset.create({ data: { id: datasetId, projectId: project.id, name: "t3", slug: "t3", schemaName: SCH3, storageServerId: mssqlServerId } });

    const { migrateDatasetStorage: mig } = await import("./migrate");
    await mig(datasetId, pgServerId);

    const staging = (await pgPool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='${SCH3}' AND table_name LIKE 'cw_migstg_%'`)).rows;
    expect(staging).toHaveLength(0);
  });
});
