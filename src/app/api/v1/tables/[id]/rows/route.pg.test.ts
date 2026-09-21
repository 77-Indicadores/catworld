/**
 * Rota `rows` contra Postgres REAL (ENT-05): baseline paginado sem perda, `since` incremental com microssegundos e UTC,
 * exclusoes em `removedKeys`, `since` invalido = 400. So roda com CW_TEST_PG_URL (Postgres descartavel — NUNCA producao).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

const S = "rows_route_test";
const url = process.env.CW_TEST_PG_URL;
const d = url ? describe : describe.skip;

const tableRow = {
  id: "t1", sqlName: "vendas", source: { mode: "extract", keyColumn: "id", connection: null },
  dataset: { id: "ds1", projectId: "p1", schemaName: S, storageServerId: "srv" },
  columns: [{ sqlName: "id", sqlType: "BIGINT", ordinal: 1 }, { sqlName: "valor", sqlType: "INT", ordinal: 2 }],
};

vi.mock("@/server/db", () => ({ prisma: { datasetTable: { findUniqueOrThrow: async () => tableRow }, $queryRawUnsafe: async () => [] } }));
vi.mock("@/server/auth/actor", () => ({ resolveActor: async () => ({ role: "ADMIN", principal: "admin" }) }));
vi.mock("@/server/auth/permissions", () => ({ canAccess: async () => true }));

d("rota rows (Postgres real)", { timeout: 60_000 }, () => {
  const pool = new Pool({ connectionString: url });
  let conn: import("@/server/storage/pg-storage").PgStorageConnection;

  const get = async (qs: string) => {
    const { GET } = await import("./route");
    const { NextRequest } = await import("next/server");
    const res = await GET(new NextRequest(`http://localhost/api/v1/tables/t1/rows${qs}`), { params: Promise.resolve({ id: "t1" }) });
    return { status: res.status, body: await res.json() };
  };

  beforeAll(async () => {
    const { PgStorageConnection } = await import("@/server/storage/pg-storage");
    conn = new PgStorageConnection("test-rows", url!);
    const c = await import("@/server/storage/connection");
    vi.spyOn(c, "getStorageConnection").mockResolvedValue(conn);
    await pool.query(`DROP SCHEMA IF EXISTS ${S} CASCADE; CREATE SCHEMA ${S};
      CREATE TABLE ${S}.vendas (id bigint, valor int, cw_synced_at timestamp NOT NULL DEFAULT now(), cw_deleted_at timestamp NULL);
      INSERT INTO ${S}.vendas (id, valor, cw_synced_at)
        SELECT g, g, timestamp '2026-01-01 00:00:00' + (g || ' milliseconds')::interval FROM generate_series(1, 250) g`);
  });
  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
    await pool.end();
    await conn._pool.end();
  });

  it("baseline paginado por cursor entrega TODAS as linhas, sem repetir", async () => {
    const ids: number[] = [];
    let qs = "?limit=100";
    let nextSince = "";
    for (let i = 0; i < 10; i++) {
      const r = await get(qs);
      expect(r.status).toBe(200);
      ids.push(...r.body.data.map((x: { id: string | number }) => Number(x.id)));
      nextSince = r.body.meta.nextSince;
      if (!r.body.meta.hasMore) break;
      qs = `?limit=100&cursor=${encodeURIComponent(r.body.meta.nextCursor)}`;
    }
    expect(ids).toHaveLength(250);
    expect(new Set(ids).size).toBe(250);
    expect(nextSince).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  });

  it("since incremental: so o que mudou, exclusao em removedKeys, sem depender do fuso", async () => {
    await pool.query(`UPDATE ${S}.vendas SET valor = 999, cw_synced_at = timestamp '2026-06-01 12:00:00.123456' WHERE id = 7`);
    await pool.query(`UPDATE ${S}.vendas SET cw_deleted_at = timestamp '2026-06-01 12:00:01.5' WHERE id = 8`);
    const r = await get(`?since=${encodeURIComponent("2026-05-01T00:00:00Z")}&limit=100`);
    expect(r.status).toBe(200);
    expect(r.body.data.map((x: { id: string | number }) => Number(x.id))).toEqual([7]);
    expect(r.body.meta.removedKeys.map(Number)).toEqual([8]);
    expect(r.body.meta.nextSince >= "2026-06-01T12:00:01").toBe(true);
  });

  it("since invalido devolve 400 (INVALID_SINCE)", async () => {
    const r = await get(`?since=nao-e-data`);
    expect(r.status).toBe(400);
    const y0 = await get(`?since=${encodeURIComponent("0000-01-01T00:00:00Z")}`);
    expect(y0.status).toBe(400);
  });
});
