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

  // ---- ENT-03: a uniao das paginas e exatamente a tabela, mesmo com ORDER BY nao unico ----
  it("paginacao com OFFSET e ORDER BY nao unico: uniao das paginas == tabela (multiconjunto)", async () => {
    await pool.query(`CREATE TABLE "${SCH}".pg1 AS SELECT g AS id, (g % 7) AS k, md5(g::text) AS h FROM generate_series(1, 20000) g`);
    // embaralha o layout fisico para o empate nao sair na ordem "natural"
    await pool.query(`CREATE TABLE "${SCH}".pg2 AS SELECT * FROM "${SCH}".pg1 ORDER BY h`);
    const expected = (await pool.query(`SELECT id, k, h FROM "${SCH}".pg2`)).rows.map((r) => `${r.id}|${r.k}|${r.h}`).sort();
    const cases = [
      "SELECT id, k, h FROM pg2 ORDER BY k",
      "SELECT id, k, h FROM pg2", // sem ORDER BY
      "SELECT id, k, h FROM pg2 ORDER BY k DESC",
    ];
    for (const sql of cases) {
      const seen: string[] = [];
      let offset = 0;
      let warned = false;
      for (let guard = 0; guard < 50; guard++) {
        const r = await executeReadOnlyPg(conn, sql, 60, 1500, [SCH], offset, false, null);
        if (r.warnings?.length) warned = true;
        seen.push(...r.rows.map((x) => `${x.id}|${x.k}|${x.h}`));
        if (!r.truncated) break;
        offset += r.rowCount;
      }
      expect(seen.length, sql).toBe(expected.length);
      expect([...seen].sort(), sql).toEqual(expected);
      if (!/ORDER BY/i.test(sql)) expect(warned, "aviso SEM_ORDER_BY").toBe(true);
    }
  }, 120_000);

  it("a ordem do ORDER BY do usuario e respeitada (chave primaria) e TOP+offset seguem validos", async () => {
    const r = await executeReadOnlyPg(conn, "SELECT TOP 100 id FROM pg1 ORDER BY k, id", 60, 30, [SCH], 60, false, null);
    expect(r.rowCount).toBe(30);
    const ids = r.rows.map((x) => x.id as number);
    const all = (await pool.query(`SELECT id FROM "${SCH}".pg1 ORDER BY k, id LIMIT 100`)).rows.map((x) => x.id);
    expect(ids).toEqual(all.slice(60, 90));
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
