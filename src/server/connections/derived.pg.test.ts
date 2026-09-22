/**
 * Tabela derivada contra Postgres REAL (FON-09): nao materializa linhas excluidas na origem, nao troca a tabela por 0 linhas
 * (guarda de integridade) e falha com status visivel em vez de ficar "running" para sempre. So roda com CW_TEST_PG_URL.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

const S = "drv_test";
const state = {
  dt: { id: "dt1", datasetId: "ds1", name: "resumo", sqlName: "resumo", querySql: "", refreshCron: null, targetTableId: null as string | null, lastRowCount: null as bigint | null, dataset: { storageServerId: "srv", schemaName: S } },
  updates: [] as Array<Record<string, unknown>>,
};

vi.mock("@/server/db", () => ({
  prisma: {
    $queryRawUnsafe: async () => [],
    derivedTable: {
      findUniqueOrThrow: async () => state.dt,
      update: async (a: { data: Record<string, unknown> }) => { state.updates.push(a.data); if ("lastRowCount" in a.data) state.dt.lastRowCount = a.data.lastRowCount as bigint; return {}; },
    },
    datasetTable: { findFirst: async () => ({ id: "t1" }), create: async () => ({ id: "t1" }), update: async () => ({}) },
    datasetColumn: { deleteMany: async () => ({}), createMany: async () => ({}) },
  },
}));
vi.mock("@/server/db/advisory-lock", () => ({ withAdvisoryLock: async (_k: string, f: () => unknown) => f() }));

const url = process.env.CW_TEST_PG_URL;
const d = url ? describe : describe.skip;

d("tabela derivada (Postgres real)", { timeout: 60_000 }, () => {
  const pool = new Pool({ connectionString: url });
  let conn: import("@/server/storage/pg-storage").PgStorageConnection;

  beforeAll(async () => {
    const { PgStorageConnection } = await import("@/server/storage/pg-storage");
    conn = new PgStorageConnection("test-drv", url!);
    const conn_ = await import("@/server/storage/connection");
    vi.spyOn(conn_, "getStorageConnection").mockResolvedValue(conn);
    await pool.query(`DROP SCHEMA IF EXISTS ${S} CASCADE; CREATE SCHEMA ${S};
      CREATE TABLE ${S}.vendas (id int, cliente text, valor int, cw_synced_at timestamp NOT NULL DEFAULT now(), cw_deleted_at timestamp NULL);
      INSERT INTO ${S}.vendas (id, cliente, valor, cw_deleted_at) VALUES (1,'a',10,NULL),(2,'a',20,NULL),(3,'b',30,NULL),(4,'b',1000,now()),(5,'c',5000,now())`);
  });
  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
    await pool.end();
    await conn._pool.end();
  });

  it("nao materializa linhas excluidas na origem", async () => {
    const { refreshDerivedTable } = await import("./derived");
    state.dt.querySql = `SELECT cliente, SUM(valor) AS total FROM ${S}.vendas GROUP BY cliente`;
    await refreshDerivedTable("dt1");
    const r = await pool.query(`SELECT cliente, total::int total FROM ${S}.resumo ORDER BY cliente`);
    expect(r.rows).toEqual([{ cliente: "a", total: 30 }, { cliente: "b", total: 30 }]);
    expect(state.updates.at(-1)).toMatchObject({ lastStatus: "ok" });
  });

  it("consulta que devolve 0 linhas sobre tabela cheia NAO troca a tabela: falha visivel, dados anteriores intactos", async () => {
    const { refreshDerivedTable } = await import("./derived");
    // baseline com >= 50 linhas para a regra de vazio/queda valer
    await pool.query(`INSERT INTO ${S}.vendas (id, cliente, valor) SELECT g, 'x' || g, g FROM generate_series(100, 199) g`);
    state.dt.querySql = `SELECT id, cliente FROM ${S}.vendas`;
    await refreshDerivedTable("dt1");
    const before = (await pool.query(`SELECT count(*)::int n FROM ${S}.resumo`)).rows[0].n;
    expect(before).toBeGreaterThanOrEqual(100);

    state.dt.querySql = `SELECT id, cliente FROM ${S}.vendas WHERE id < 0`;
    await expect(refreshDerivedTable("dt1")).rejects.toThrow(/integrity/);
    const after = (await pool.query(`SELECT count(*)::int n FROM ${S}.resumo`)).rows[0].n;
    expect(after).toBe(before);
    expect(state.updates.at(-1)).toMatchObject({ lastStatus: "failed" });
    // nenhuma staging sobrando
    const left = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='${S}' AND table_name LIKE '__drv_%'`);
    expect(left.rows).toHaveLength(0);
  });
});
