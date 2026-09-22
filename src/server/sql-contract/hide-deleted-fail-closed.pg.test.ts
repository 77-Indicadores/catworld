/**
 * ENT-01 (prototipo): o filtro de excluidas nao pode falhar aberto. Postgres real (CW_TEST_PG_URL); schema unico por execucao.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

vi.mock("@/server/db", () => ({ prisma: { $queryRawUnsafe: async () => [] } }));

import { PgStorageConnection } from "@/server/storage/pg-storage";
import { executeReadOnlyPg } from "@/server/storage/pg-query";
import { hideDeletedForStorage, DeletedFilterUnverifiable } from "./hide-deleted-run";
import { hideDeletedByTokens } from "./hide-deleted-text";
import type { TableState } from "./hide-deleted";

const url = process.env.CW_TEST_PG_URL;
const d = url ? describe : describe.skip;
const S = `hdfc_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`;

d("hide-deleted falha FECHADA (ENT-01)", () => {
  const pool = new Pool({ connectionString: url });
  const conn = new PgStorageConnection(`test-hdfc-${S}`, url!);
  const rewrite = (sql: string, schemas: string[] = []) => hideDeletedForStorage(conn, sql, schemas, "test");
  /** Reescreve e executa o SQL reescrito DIRETO no Postgres (para sintaxe que so o Postgres/T-SQL comum entende). */
  const exec = async (sql: string, schemas: string[] = []) => (await pool.query(await rewrite(sql, schemas))).rows;

  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA ${S};
      CREATE TABLE ${S}.vendas (id int, cliente text, valor int, cw_synced_at timestamp NOT NULL DEFAULT now(), cw_deleted_at timestamp NULL);
      INSERT INTO ${S}.vendas (id, cliente, valor, cw_deleted_at) VALUES (1,'a',10,NULL),(2,'a',20,NULL),(3,'b',30,NULL),(4,'b',1000,now()),(5,'c',5000,now());
      CREATE TABLE ${S}.clientes (cliente text, nome text);
      INSERT INTO ${S}.clientes VALUES ('a','Ana'),('b','Bia'),('c','Caio')`);
  });
  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
    await pool.end();
    await conn._pool.end();
  });

  it("baseline: sem o filtro o dono ve as 5 linhas", async () => {
    expect((await pool.query(`SELECT count(*)::int n FROM ${S}.vendas`)).rows[0].n).toBe(5);
  });

  it("REGRESSAO/PROVA: so o AST (comportamento atual) devolve o SQL intacto = linhas excluidas vazam", async () => {
    const { hideDeletedRows } = await import("./hide-deleted");
    const lookup = (s: string, t: string) => conn.listColumns(s, t).then((c): TableState => (c.length === 0 ? "missing" : c.some((x) => x.name === "cw_deleted_at") ? "deleted" : "plain"));
    for (const q of [
      `SELECT TRY_CAST(valor AS INT) FROM ${S}.vendas`,
      `SELECT id FROM ${S}.vendas EXCEPT SELECT 1`,
      `SELECT id FROM ${S}.vendas WHERE cliente LIKE 'a!%' ESCAPE '!'`,
    ]) {
      const r = await hideDeletedRows(q, { schemas: [], lookup });
      expect({ q, skipped: r.skipped, same: r.sql === q }).toEqual({ q, skipped: true, same: true }); // falha ABERTA hoje
    }
  });

  it("TRY_CAST (o parser de AST nao le): filtra e roda pelo pipeline completo", async () => {
    const r = await executeReadOnlyPg(conn, await rewrite(`SELECT TRY_CAST(valor AS INT) AS v FROM ${S}.vendas ORDER BY id`), 30, 100, [], 0, false, null);
    expect(r.rows.map((x) => x.v)).toEqual([10, 20, 30]);
  });

  it("EXCEPT", async () => {
    const rows = await exec(`SELECT id FROM ${S}.vendas EXCEPT SELECT id FROM ${S}.vendas WHERE valor > 20 ORDER BY id`);
    expect(rows.map((x) => x.id)).toEqual([1, 2]);
    const all = await exec(`SELECT id FROM ${S}.vendas EXCEPT SELECT id FROM ${S}.clientes_inexistente_x`.replace("FROM " + S + ".clientes_inexistente_x", "FROM (SELECT 99 AS id) z"));
    expect(all.map((x) => x.id).sort()).toEqual([1, 2, 3]);
  });

  it("GROUP BY ROLLUP", async () => {
    const rows = await exec(`SELECT cliente, SUM(valor) AS total FROM ${S}.vendas GROUP BY ROLLUP(cliente) ORDER BY cliente`);
    expect(rows.map((x) => [x.cliente, Number(x.total)])).toEqual([["a", 30], ["b", 30], [null, 60]]);
  });

  it("t.* e alias", async () => {
    const rows = await exec(`SELECT t.* FROM ${S}.vendas t WHERE t.valor >= 0 EXCEPT SELECT * FROM ${S}.vendas WHERE id = 1 ORDER BY 1`);
    expect(rows.map((x) => x.id)).toEqual([2, 3]);
  });

  it("LIKE ... ESCAPE", async () => {
    const rows = await exec(`SELECT id FROM ${S}.vendas WHERE cliente LIKE 'b!%' ESCAPE '!' OR cliente LIKE 'b' ESCAPE '!' ORDER BY id`);
    expect(rows.map((x) => x.id)).toEqual([3]); // o id 4 (b, excluido) nao aparece
  });

  it("join, subconsulta, virgula, CTE com nome de tabela e schema.tabela.coluna sem alias", async () => {
    const j = await exec(`SELECT c.nome, SUM(v.valor) AS total FROM ${S}.vendas v JOIN ${S}.clientes c ON c.cliente = v.cliente GROUP BY ROLLUP(c.nome) ORDER BY c.nome`);
    expect(j.map((x) => [x.nome, Number(x.total)])).toEqual([["Ana", 30], ["Bia", 30], [null, 60]]);
    const comma = await exec(`SELECT v.id FROM ${S}.clientes c, ${S}.vendas v WHERE c.cliente = v.cliente EXCEPT SELECT 1 ORDER BY 1`);
    expect(comma.map((x) => x.id)).toEqual([2, 3]);
    const cte = await exec(`WITH vendas AS (SELECT 1 AS id) SELECT id FROM vendas EXCEPT SELECT 0 ORDER BY 1`);
    expect(cte.map((x) => x.id)).toEqual([1]);
    const q = await exec(`SELECT ${S}.vendas.id FROM ${S}.vendas EXCEPT SELECT 1 ORDER BY 1`);
    expect(q.map((x) => x.id)).toEqual([2, 3]);
    const sub = await exec(`SELECT n FROM (SELECT COUNT(*) AS n FROM ${S}.vendas) z EXCEPT SELECT -1`);
    expect(Number(sub[0]!.n)).toBe(3);
  });

  it("nome de tabela em string/comentario nao e tocado; tabela sem a coluna fica intacta byte a byte", async () => {
    const sql = `SELECT 'FROM ${S}.vendas' AS s FROM ${S}.clientes -- FROM ${S}.vendas\n EXCEPT SELECT 'x','y' WHERE 1=0`;
    expect(await rewrite(sql)).toBe(sql);
  });

  it("tabela sem schema resolvida pelo escopo", async () => {
    const sql = await rewrite(`SELECT TRY_CAST(id AS INT) AS id FROM vendas ORDER BY 1`, [S]);
    expect(sql).toContain("cw_deleted_at IS NULL");
    const r = await executeReadOnlyPg(conn, sql, 30, 100, [S], 0, false, null);
    expect(r.rows.map((x) => x.id)).toEqual([1, 2, 3]);
  });

  it("SUBSTRING(x FROM 1 FOR 2) nao e confundido com FROM de tabela", async () => {
    const rows = await exec(`SELECT SUBSTRING(cliente FROM 1 FOR 1) AS c FROM ${S}.vendas EXCEPT SELECT 'zz' ORDER BY 1`);
    expect(rows.map((x) => x.c)).toEqual(["a", "b"]);
  });

  describe("2a barreira falha FECHADA", () => {
    const lookup = async (_s: string, t: string): Promise<TableState> => (t === "vendas" ? "deleted" : "plain");
    it("dica de tabela + tabela protegida: nao ha como garantir -> ok=false", async () => {
      const r = await hideDeletedByTokens(`SELECT id FROM ${S}.vendas WITH (INDEX(ix)) EXCEPT SELECT 1`, { schemas: [], lookup });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/dica/);
    });
    it("a mesma construcao numa tabela SEM a coluna passa (nao ha o que proteger)", async () => {
      const r = await hideDeletedByTokens(`SELECT * FROM ${S}.clientes WITH (INDEX(ix)) EXCEPT SELECT 1, 2`, { schemas: [], lookup });
      expect(r).toMatchObject({ ok: true, rewritten: 0 });
    });
    it("falha do catalogo (lookup lanca): a consulta e recusada, nao liberada", async () => {
      const broken = new PgStorageConnection(`test-hdfc-broken-${S}`, "postgres://nobody:x@127.0.0.1:1/none");
      await expect(hideDeletedForStorage(broken, `SELECT id FROM ${S}.vendas EXCEPT SELECT 1`, [], "test")).rejects.toBeInstanceOf(DeletedFilterUnverifiable);
      await broken._pool.end().catch(() => undefined);
    });
    it("erro tem codigo e status estaveis", async () => {
      const broken = new PgStorageConnection(`test-hdfc-broken2-${S}`, "postgres://nobody:x@127.0.0.1:1/none");
      await expect(hideDeletedForStorage(broken, `SELECT id FROM ${S}.vendas EXCEPT SELECT 1`, [], "test")).rejects.toMatchObject({ status: 400, code: "DELETED_FILTER_UNVERIFIABLE" });
      await broken._pool.end().catch(() => undefined);
    });
  });
});
