/** H4: date[]/timestamp[]/timestamptz[] chegam como TEXTO, sem deslocamento do fuso do Node. Postgres real (CW_TEST_PG_URL). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PG_STRING_TYPES } from "./pg-types";

const url = process.env.CW_TEST_PG_URL;
const d = url ? describe : describe.skip;

d.each(["UTC", "America/New_York", "Asia/Tokyo"])("arrays de data como texto: TZ=%s", (tz) => {
  const original = process.env.TZ;
  const pool = new Pool({ connectionString: url });
  beforeAll(() => { process.env.TZ = tz; });
  afterAll(async () => {
    if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
    await pool.end();
  });

  it("date[] / timestamp[] / timestamptz[] mantem o texto do banco", async () => {
    const r = await pool.query({
      text: `SELECT ARRAY['2024-03-10'::date, NULL, 'infinity'::date] AS d,
                    ARRAY['2024-03-10 02:30:00.123456'::timestamp] AS t,
                    ARRAY['2024-03-10 02:30:00+00'::timestamptz] AS z,
                    ARRAY['a','b'] AS s, ARRAY[1,2] AS n`,
      types: PG_STRING_TYPES,
    });
    const row = r.rows[0];
    expect(row.d).toEqual(["2024-03-10", null, "infinity"]);
    expect(row.t).toEqual(["2024-03-10 02:30:00.123456"]);
    expect(row.z).toHaveLength(1);
    expect(typeof row.z[0]).toBe("string");
    expect(row.s).toEqual(["a", "b"]);
    expect(row.n).toEqual([1, 2]);
  });
});
