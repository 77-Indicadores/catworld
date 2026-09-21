/**
 * ENT-02 / ENT-03 contra Postgres real (so com CW_TEST_PG_URL; schemas com nome unico por execucao).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

vi.mock("@/server/db", () => ({ prisma: { $queryRawUnsafe: async () => [] } }));

import { executeReadOnlyPg } from "./pg-query";

const url = process.env.CW_TEST_PG_URL;
const d = url ? describe : describe.skip;
const SCH = `pqs_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`;

d("pg-query: escopo de tabelas (ENT-02)", () => {
  const pool = new Pool({ connectionString: url });
  const conn = { _pool: pool } as never;
  const q = (sql: string) => executeReadOnlyPg(conn, sql, 30, 1000, [SCH], 0, false, null);

  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA "${SCH}";
      CREATE TABLE "${SCH}".vendas (id int, vendas int, valor int);
      INSERT INTO "${SCH}".vendas VALUES (1,10,100),(2,20,200),(3,30,300)`);
  });
  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${SCH}" CASCADE`);
    await pool.end();
  });

  it("CTE com o nome da tabela NAO e trocada pela tabela real", async () => {
    const r = await q("WITH vendas AS (SELECT id FROM vendas WHERE id = 1) SELECT id FROM vendas");
    expect(r.rows).toEqual([{ id: 1 }]);
  });

  it("CTE com nome da tabela e filtro proprio", async () => {
    const r = await q("WITH vendas AS (SELECT TOP 1 id FROM vendas ORDER BY id DESC) SELECT * FROM vendas");
    expect(r.rows).toEqual([{ id: 3 }]);
  });

  it("coluna com o nome da tabela nao e reescrita", async () => {
    const r = await q("SELECT vendas FROM vendas ORDER BY id");
    expect(r.columns).toEqual(["vendas"]);
    expect(r.rows.map((x) => x.vendas)).toEqual([10, 20, 30]);
  });

  it("alias com o nome da tabela nao e reescrito", async () => {
    const r = await q("SELECT valor AS vendas FROM vendas ORDER BY id");
    expect(r.columns).toEqual(["vendas"]);
    expect(r.rows.map((x) => x.vendas)).toEqual([100, 200, 300]);
    const r2 = await q("SELECT vendas.id FROM vendas AS vendas ORDER BY vendas.id");
    expect(r2.rows.map((x) => x.id)).toEqual([1, 2, 3]);
  });

  it("nome existente em 2 datasets continua ambiguo, mas CTE homonima nao dispara ambiguidade", async () => {
    const S2 = `${SCH}_b`;
    await pool.query(`CREATE SCHEMA "${S2}"; CREATE TABLE "${S2}".vendas (id int); INSERT INTO "${S2}".vendas VALUES (9)`);
    try {
      await expect(executeReadOnlyPg(conn, "SELECT id FROM vendas", 30, 10, [SCH, S2], 0, false, null)).rejects.toMatchObject({ code: "AMBIGUOUS_TABLE" });
      const r = await executeReadOnlyPg(conn, "WITH vendas AS (SELECT 5 AS id) SELECT id FROM vendas", 30, 10, [SCH, S2], 0, false, null);
      expect(r.rows).toEqual([{ id: 5 }]);
    } finally {
      await pool.query(`DROP SCHEMA "${S2}" CASCADE`);
    }
  });
});
