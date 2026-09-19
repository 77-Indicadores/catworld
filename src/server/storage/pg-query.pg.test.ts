/**
 * pg-query.ts contra Postgres real: colunas duplicadas, normalize e timeout. So roda com CW_TEST_PG_URL
 * (Postgres descartavel — NUNCA producao).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

vi.mock("@/server/db", () => ({ prisma: { $queryRawUnsafe: async () => [] } }));

import { executeReadOnlyPg, executeReadOnlyPgStream } from "./pg-query";
import { isQueryTimeout } from "@/server/http";

const url = process.env.CW_TEST_PG_URL;
const d = url ? describe : describe.skip;

d("pg-query (executando)", () => {
  const pool = new Pool({ connectionString: url });
  const conn = { _pool: pool } as never;

  beforeAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS pq CASCADE; CREATE SCHEMA pq;
      CREATE TABLE pq.t (id int, nome text, dia date, big bigint);
      INSERT INTO pq.t VALUES (1,'ana','2026-01-31',9007199254740993),(2,'bia','2026-02-01',2)`);
  });
  afterAll(async () => {
    await pool.query("DROP SCHEMA IF EXISTS pq CASCADE");
    await pool.end();
  });

  it("colunas de mesmo nome NAO se perdem: Id, Id_2", async () => {
    const r = await executeReadOnlyPg(conn, "SELECT a.[id], b.[id] FROM pq.t a JOIN pq.t b ON a.id = b.id ORDER BY a.id", 30, 100, [], 0, false, null);
    expect(r.columns).toEqual(["id", "id_2"]);
    expect(r.rows).toEqual([{ id: 1, id_2: 1 }, { id: 2, id_2: 2 }]);
  });

  it("tres colunas iguais e um nome ja sufixado", async () => {
    const r = await executeReadOnlyPg(conn, "SELECT 1 AS x, 2 AS x, 3 AS x_2, 4 AS x", 30, 100, [], 0, false, null);
    expect(r.columns).toEqual(["x", "x_3", "x_2", "x_4"]);
    expect(r.rows[0]).toEqual({ x: 1, x_3: 2, x_2: 3, x_4: 4 });
  });

  it("normalize continua valendo com os nomes finais (colunas repetidas)", async () => {
    const r = await executeReadOnlyPg(conn, "SELECT a.[dia], b.[dia], a.[big] FROM pq.t a JOIN pq.t b ON a.id = b.id WHERE a.id = 1", 30, 100, [], 0, true, null);
    expect(r.columns).toEqual(["dia", "dia_2", "big"]);
    expect(r.rows[0]).toEqual({ dia: "2026-01-31", dia_2: "2026-01-31", big: "9007199254740993" });
  });

  // ---- contrato do TOP: limita o CONJUNTO; limit/offset paginam DENTRO dele; teto de pagina sempre vale ----
  it("TOP n + offset: o TOP vale primeiro (igual ao SQL Server) — TOP 2 e offset 1 -> so o 2o", async () => {
    const r = await executeReadOnlyPg(conn, "SELECT TOP 2 [id] FROM pq.t ORDER BY id", 30, 100, [], 1, false, null);
    expect(r.rows).toEqual([{ id: 2 }]);
    expect(r.truncated).toBe(false);
  });

  it("TOP 20 com limit 10: 1a pagina truncada, 2a completa, 3a vazia", async () => {
    const sql = "SELECT TOP 20 g FROM generate_series(1, 100) AS g ORDER BY g";
    const p1 = await executeReadOnlyPg(conn, sql, 30, 10, [], 0, false, null);
    expect(p1.rows.map((x) => x.g)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(p1.truncated).toBe(true); // ha mais linhas DENTRO do conjunto do TOP
    const p2 = await executeReadOnlyPg(conn, sql, 30, 10, [], 10, false, null);
    expect(p2.rows.map((x) => x.g)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(p2.truncated).toBe(false);
    const p3 = await executeReadOnlyPg(conn, sql, 30, 10, [], 20, false, null);
    expect(p3.rowCount).toBe(0);
  });

  it("TOP acima do teto de 10000 nao passa dele (antes devolvia todas)", async () => {
    const r = await executeReadOnlyPg(conn, "SELECT TOP 20000 g FROM generate_series(1, 30000) AS g ORDER BY g", 30, 10000, [], 0, false, null);
    expect(r.rowCount).toBe(10000);
    expect(r.truncated).toBe(true);
  });

  it("formato legado: informa as colunas que mudariam com normalize; com normalize nao informa", async () => {
    const legacy = await executeReadOnlyPg(conn, "SELECT id, dia FROM pq.t ORDER BY id", 30, 100, [], 0, false, null);
    expect(legacy.legacyFormatColumns).toEqual(["dia"]);
    const norm = await executeReadOnlyPg(conn, "SELECT id, dia FROM pq.t ORDER BY id", 30, 100, [], 0, true, null);
    expect(norm.legacyFormatColumns).toBeUndefined();
    const plain = await executeReadOnlyPg(conn, "SELECT id, nome FROM pq.t ORDER BY id", 30, 100, [], 0, false, null);
    expect(plain.legacyFormatColumns).toBeUndefined();
  });

  it("estouro de tempo e reconhecido como QUERY_TIMEOUT (codigo 57014)", async () => {
    let err: unknown;
    try {
      await executeReadOnlyPg(conn, "SELECT COUNT(*) FROM generate_series(1, 400000000) g", 1, 100, [], 0, false, null);
    } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(isQueryTimeout(err)).toBe(true);
  }, 30_000);

  it("stream: colunas duplicadas, e __error__ com codigo QUERY_TIMEOUT", async () => {
    const read = async (sql: string, timeout = 60) => {
      const s = await executeReadOnlyPgStream(conn, sql, timeout, [], false, null);
      const text = await new Response(s).text();
      return text.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    };
    const ok = await read("SELECT a.[id], b.[id] FROM pq.t a JOIN pq.t b ON a.id = b.id ORDER BY a.id");
    expect(ok[0]).toEqual({ __columns__: ["id", "id_2"] });
    expect(ok[1]).toEqual({ id: 1, id_2: 1 });
    expect(ok.at(-1)).toMatchObject({ __done__: true, rowCount: 2 });

    const bad = await read("SELECT COUNT(*) FROM generate_series(1, 400000000) g", 1);
    expect(bad.at(-1)).toMatchObject({ __error__: true, code: "QUERY_TIMEOUT" });
  }, 30_000);
});
