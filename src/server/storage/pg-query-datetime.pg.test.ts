/**
 * ENT-06: DATE/TIMESTAMP entregues sem depender do fuso do Node, com microssegundos e 'infinity'.
 * Postgres real (CW_TEST_PG_URL); schema unico por execucao.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

vi.mock("@/server/db", () => ({ prisma: { $queryRawUnsafe: async () => [] } }));

import { executeReadOnlyPg, executeReadOnlyPgStream } from "./pg-query";

const url = process.env.CW_TEST_PG_URL;
const d = url ? describe : describe.skip;
const SCH = `pqd_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`;

d.each(["UTC", "Asia/Tokyo", "America/Sao_Paulo", "America/New_York"])("datas/horas independentes do fuso do processo: TZ=%s", (tz) => {
  const original = process.env.TZ;
  const pool = new Pool({ connectionString: url });
  const conn = { _pool: pool } as never;
  const run = (sql: string, normalize: boolean) => executeReadOnlyPg(conn, sql, 30, 100, [SCH], 0, normalize, null);

  beforeAll(async () => {
    process.env.TZ = tz;
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${SCH}";
      CREATE TABLE IF NOT EXISTS "${SCH}".dt (id int, dia date, ts timestamp, tstz timestamptz);
      DELETE FROM "${SCH}".dt;
      INSERT INTO "${SCH}".dt VALUES
        (1, '2026-01-31', '2026-09-19 10:00:00.123456', '2026-09-19 13:00:00.123456+00'),
        (2, '2026-03-08', '2026-03-08 02:30:00', '2026-03-08 02:30:00-03'),
        (3, 'infinity', 'infinity', 'infinity'),
        (4, '-infinity', '-infinity', '-infinity'),
        (5, '2026-11-01', '2026-11-01 01:30:00.5', NULL)`);
  });
  afterAll(async () => {
    if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
    await pool.query(`DROP SCHEMA IF EXISTS "${SCH}" CASCADE`);
    await pool.end();
  });

  it("o fuso foi aplicado (sanidade)", () => {
    expect(new Date(2026, 0, 15).getTimezoneOffset()).toBe({ UTC: 0, "Asia/Tokyo": -540, "America/Sao_Paulo": 180, "America/New_York": 300 }[tz]);
  });

  it("normalize=true: DATE 'YYYY-MM-DD'; TIMESTAMP ISO UTC com microssegundos; infinity preservado; lacuna de DST intacta", async () => {
    const r = await run("SELECT id, dia, ts FROM dt ORDER BY id", true);
    expect(r.rows).toEqual([
      { id: 1, dia: "2026-01-31", ts: "2026-09-19T10:00:00.123456Z" },
      { id: 2, dia: "2026-03-08", ts: "2026-03-08T02:30:00.000Z" }, // 02:30 nao existe em America/New_York: nao pode virar 03:30
      { id: 3, dia: "infinity", ts: "infinity" },
      { id: 4, dia: "-infinity", ts: "-infinity" },
      { id: 5, dia: "2026-11-01", ts: "2026-11-01T01:30:00.500Z" },
    ]);
  });

  it("normalize=true: timestamptz convertido para UTC (nao para o fuso do processo)", async () => {
    const r = await run("SELECT id, tstz FROM dt WHERE id IN (1,2,5) ORDER BY id", true);
    expect(r.rows).toEqual([
      { id: 1, tstz: "2026-09-19T13:00:00.123456Z" },
      { id: 2, tstz: "2026-03-08T05:30:00.000Z" },
      { id: 5, tstz: null },
    ]);
  });

  it("formato legado (normalize=false) = o que um Node em UTC entregava, sem depender do fuso e sem perder microssegundos", async () => {
    const r = await run("SELECT id, dia, ts FROM dt WHERE id IN (1,3) ORDER BY id", false);
    expect(r.rows).toEqual([
      { id: 1, dia: "2026-01-31T00:00:00.000Z", ts: "2026-09-19T10:00:00.123456Z" },
      { id: 3, dia: "infinity", ts: "infinity" },
    ]);
  });

  it("stream entrega o mesmo", async () => {
    const s = await executeReadOnlyPgStream(conn, "SELECT id, dia, ts FROM dt WHERE id IN (1,3) ORDER BY id", 30, [SCH], true, null);
    const lines = (await new Response(s).text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[1]).toEqual({ id: 1, dia: "2026-01-31", ts: "2026-09-19T10:00:00.123456Z" });
    expect(lines[2]).toEqual({ id: 3, dia: "infinity", ts: "infinity" });
  });
});
