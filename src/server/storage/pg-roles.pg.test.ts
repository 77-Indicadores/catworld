/**
 * Isolamento por papel no Postgres — executado de verdade. So roda com CW_TEST_PG_URL (Postgres descartavel,
 * conta com CREATEROLE ou superusuario — NUNCA producao):
 *   CW_TEST_PG_URL=postgres://catworld:catworld_dev@localhost:5433/postgres npx vitest run pg-roles
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";

vi.mock("@/server/db", () => ({ prisma: { $queryRawUnsafe: async () => [] } }));

import { invalidatePgRoleCache, syncPgReaderRole } from "./pg-roles";

const url = process.env.CW_TEST_PG_URL;
const d = url ? describe : describe.skip;

d("isolamento por papel no Postgres (executando)", () => {
  const pool = new Pool({ connectionString: url });
  const ROLE = "cw_t_isolamento_teste";

  /** Executa `sql` como o ator: BEGIN READ ONLY + SET LOCAL ROLE (o mesmo que pg-query.ts faz). */
  async function asActor(sql: string) {
    const c: PoolClient = await pool.connect();
    try {
      await c.query("BEGIN READ ONLY");
      await c.query(`SET LOCAL ROLE "${ROLE}"`);
      const r = await c.query(sql);
      return r.rows as Record<string, unknown>[];
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  }
  const code = async (sql: string) => { try { await asActor(sql); return "ok"; } catch (e) { return (e as { code?: string }).code ?? String(e); } };

  beforeAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS iso_a CASCADE; DROP SCHEMA IF EXISTS iso_b CASCADE;
      CREATE SCHEMA iso_a; CREATE SCHEMA iso_b;
      CREATE TABLE iso_a.t (v int); INSERT INTO iso_a.t VALUES (1),(2);
      CREATE TABLE iso_b.folha (nome text, salario int); INSERT INTO iso_b.folha VALUES ('diretor', 99999);`);
    await pool.query(`DROP ROLE IF EXISTS "${ROLE}"`).catch(() => undefined);
    invalidatePgRoleCache();
  });
  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS iso_a CASCADE; DROP SCHEMA IF EXISTS iso_b CASCADE`);
    await pool.query(`DROP OWNED BY "${ROLE}"`).catch(() => undefined);
    await pool.query(`DROP ROLE IF EXISTS "${ROLE}"`).catch(() => undefined);
    await pool.end();
  });

  it("le o schema permitido e NAO le o outro (mesmo qualificando o nome)", async () => {
    await syncPgReaderRole("srv", pool, ROLE, ["iso_a"]);
    expect((await asActor("SELECT count(*)::int AS n FROM iso_a.t"))[0]!.n).toBe(2);
    expect(await code("SELECT * FROM iso_b.folha")).toBe("42501"); // permission denied
  });

  it("nao lista dados de outros datasets pelo information_schema", async () => {
    const rows = await asActor("SELECT table_schema FROM information_schema.tables WHERE table_schema LIKE 'iso\\_%'");
    expect(rows.map((r) => r.table_schema)).toEqual(["iso_a"]); // information_schema so mostra o que o papel pode ver
  });

  it("transacao SOMENTE LEITURA: SELECT INTO, nextval e escrita falham", async () => {
    expect(await code("SELECT * INTO iso_a.copia FROM iso_a.t")).toBe("25006"); // read_only_sql_transaction
    expect(await code("INSERT INTO iso_a.t VALUES (9)")).toMatch(/^(25006|42501)$/);
    await pool.query("CREATE SEQUENCE IF NOT EXISTS iso_a.seq");
    expect(await code("SELECT nextval('iso_a.seq')")).toMatch(/^(25006|42501)$/);
  });

  it("funcoes perigosas ficam negadas ao papel (mesmo que a conta da aplicacao seja superusuario)", async () => {
    expect(await code("SELECT pg_read_file('/etc/hostname')")).toBe("42501");
    expect(await code("SELECT pg_ls_dir('.')")).toBe("42501");
  });

  it("tabela criada DEPOIS da sincronizacao ja nasce legivel (privilegios padrao)", async () => {
    await pool.query("CREATE TABLE iso_a.nova (x int); INSERT INTO iso_a.nova VALUES (7)");
    expect((await asActor("SELECT x FROM iso_a.nova"))[0]!.x).toBe(7);
  });

  it("revogacao: ao perder o acesso, o papel deixa de ler (apos nova sincronizacao)", async () => {
    invalidatePgRoleCache();
    await syncPgReaderRole("srv", pool, ROLE, []);
    expect(await code("SELECT count(*) FROM iso_a.t")).toBe("42501");
  });

  it("conceder outro schema depois: le B e ja nao le A", async () => {
    invalidatePgRoleCache();
    await syncPgReaderRole("srv", pool, ROLE, ["iso_b"]);
    expect((await asActor("SELECT nome FROM iso_b.folha"))[0]!.nome).toBe("diretor");
    expect(await code("SELECT count(*) FROM iso_a.t")).toBe("42501");
  });

  it("SET LOCAL nao vaza para a proxima consulta do pool", async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN READ ONLY");
      await c.query(`SET LOCAL ROLE "${ROLE}"`);
      await c.query("SET LOCAL statement_timeout = 1234");
      await c.query("ROLLBACK");
      const r = await c.query("SELECT current_user AS u, current_setting('statement_timeout') AS t");
      expect(r.rows[0]!.u).not.toBe(ROLE);
      expect(r.rows[0]!.t).not.toBe("1234ms");
    } finally {
      c.release();
    }
  });
});
