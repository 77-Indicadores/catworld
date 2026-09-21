/**
 * hide-deleted contra Postgres REAL: dono da tabela (RLS nao vale) nao ve linhas marcadas pelo pipeline de consulta e pela
 * derivada; tabela sem a coluna fica intacta. So roda com CW_TEST_PG_URL (Postgres descartavel — NUNCA producao).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

vi.mock("@/server/db", () => ({ prisma: { $queryRawUnsafe: async () => [] } }));

import { PgStorageConnection } from "@/server/storage/pg-storage";
import { executeReadOnlyPg } from "@/server/storage/pg-query";
import { prepareDerivedSql } from "@/server/connections/derived";
import { hideDeletedForStorage } from "./hide-deleted-run";

const url = process.env.CW_TEST_PG_URL;
const d = url ? describe : describe.skip;
const S = "hd_test";

d("hide-deleted (Postgres real)", () => {
  const pool = new Pool({ connectionString: url });
  const conn = new PgStorageConnection("test-hd", url!);
  const run = async (sql: string, schemas: string[] = []) =>
    executeReadOnlyPg(conn, await hideDeletedForStorage(conn, sql, schemas, "test"), 30, 1000, schemas, 0, false, null);

  beforeAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${S} CASCADE; CREATE SCHEMA ${S};
      CREATE TABLE ${S}.vendas (id int, cliente text, valor int, cw_synced_at timestamp NOT NULL DEFAULT now(), cw_deleted_at timestamp NULL);
      INSERT INTO ${S}.vendas (id, cliente, valor, cw_deleted_at) VALUES
        (1,'a',10,NULL),(2,'a',20,NULL),(3,'b',30,NULL),(4,'b',1000,now()),(5,'c',5000,now());
      CREATE TABLE ${S}.clientes (cliente text, nome text);
      INSERT INTO ${S}.clientes VALUES ('a','Ana'),('b','Bia'),('c','Caio')`);
  });
  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
    await pool.end();
    await conn._pool.end();
  });

  it("baseline: o dono ve as linhas marcadas sem o filtro", async () => {
    const r = await pool.query(`SELECT count(*)::int n FROM ${S}.vendas`);
    expect(r.rows[0].n).toBe(5);
  });

  it("consulta como dono (ADMIN / isolamento off): 0 linhas marcadas", async () => {
    const r = await run(`SELECT id FROM ${S}.vendas ORDER BY id`);
    expect(r.rows.map((x) => x.id)).toEqual([1, 2, 3]);
    const agg = await run(`SELECT COUNT(*) AS n, SUM(valor) AS total FROM ${S}.vendas`);
    expect(agg.rows.map((x) => ({ n: Number(x.n), total: Number(x.total) }))).toEqual([{ n: 3, total: 60 }]);
  });

  it("alias, join, subconsulta, CTE e UNION", async () => {
    const j = await run(`SELECT c.nome, SUM(v.valor) AS total FROM ${S}.vendas v JOIN ${S}.clientes c ON c.cliente = v.cliente GROUP BY c.nome ORDER BY c.nome`);
    expect(j.rows.map((x) => ({ nome: x.nome, total: Number(x.total) }))).toEqual([{ nome: "Ana", total: 30 }, { nome: "Bia", total: 30 }]);
    const s = await run(`SELECT COUNT(*) AS n FROM ${S}.clientes WHERE cliente IN (SELECT cliente FROM ${S}.vendas)`);
    expect(Number(s.rows[0]!.n)).toBe(2);
    const c = await run(`WITH x AS (SELECT id FROM ${S}.vendas) SELECT id FROM x UNION ALL SELECT id FROM ${S}.vendas ORDER BY id`);
    expect(c.rows.map((r) => r.id)).toEqual([1, 1, 2, 2, 3, 3]);
  });

  it("tabela sem schema resolvida pelo escopo, TOP e paginacao", async () => {
    const r = await run(`SELECT TOP 2 id FROM vendas ORDER BY id DESC`, [S]);
    expect(r.rows.map((x) => x.id)).toEqual([3, 2]);
  });

  it("derivada (CTAS como dono) exclui as linhas marcadas", async () => {
    const sql = await prepareDerivedSql(`SELECT cliente, SUM(valor) AS total FROM ${S}.vendas GROUP BY cliente`, "postgres", conn);
    await conn.execute(`DROP TABLE IF EXISTS ${S}.drv; CREATE TABLE ${S}.drv AS SELECT * FROM (${sql}) AS _drv`);
    const r = await pool.query(`SELECT cliente, total::int total FROM ${S}.drv ORDER BY cliente`);
    expect(r.rows).toEqual([{ cliente: "a", total: 30 }, { cliente: "b", total: 30 }]);
  });

  it("tabela SEM a coluna: SQL e resultado intactos", async () => {
    const sql = `SELECT cliente, nome FROM ${S}.clientes ORDER BY cliente`;
    expect(await hideDeletedForStorage(conn, sql, [], "test")).toBe(sql);
    const r = await run(sql);
    expect(r.rows).toHaveLength(3);
  });

  it("SQL que o parser nao le e reescrito pelos tokens (ENT-01: falha fechada, nunca devolve excluidas)", async () => {
    const sql = `SELECT id::int AS id FROM ${S}.vendas ORDER BY id`;
    const out = await hideDeletedForStorage(conn, sql, [], "test");
    expect(out).not.toBe(sql);
    expect(out).toContain("cw_deleted_at IS NULL");
  });
});
