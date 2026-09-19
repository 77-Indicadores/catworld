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
