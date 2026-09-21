// @vitest-environment node
/** H2: cada carga (fullSwap e merge) deixa exatamente UM indice em cw_synced_at. Postgres real (CW_TEST_PG_URL, descartavel). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PgStorageConnection } from "./pg-storage";

const url = process.env.CW_TEST_PG_URL;
const d = url ? describe : describe.skip;
const S = `si_${Date.now().toString(36)}`;

d("indice cw_synced_at por carga (Postgres real)", () => {
  const admin = new Pool({ connectionString: url, max: 3 });
  const conn = new PgStorageConnection("synced-index-test", url!);
  const cols = [{ name: "id", sqlType: "BIGINT", nullable: false }, { name: "v", sqlType: "NVARCHAR(MAX)", nullable: true }];
  beforeAll(async () => { await admin.query(`CREATE SCHEMA ${S}`); });
  afterAll(async () => { await admin.query(`DROP SCHEMA ${S} CASCADE`); await admin.end(); });

  const nIdx = async (t: string) => Number((await admin.query(
    `SELECT count(*)::int n FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=i.indkey[0]
     WHERE i.indrelid = '${S}.${t}'::regclass AND a.attname='cw_synced_at'`)).rows[0].n);

  for (const mode of ["full", "merge"] as const) {
    it(`${mode}: 6 cargas seguidas, sempre exatamente um indice`, async () => {
      const target = `t_${mode}`;
      for (let i = 0; i < 6; i++) {
        await admin.query(`DROP TABLE IF EXISTS ${S}.stg`);
        await admin.query(`CREATE TABLE ${S}.stg (id bigint NOT NULL, v text)`);
        await admin.query(`INSERT INTO ${S}.stg VALUES (1,'a'), (${i + 10},'b')`);
        await conn.atomicSwap(S, "stg", target, cols as never, { targetExists: i > 0, ...(mode === "merge" ? { keyColumn: "id", mergedName: "mgd" } : {}) });
        expect(await nIdx(target), `carga ${i}`).toBe(1);
      }
    });
  }
});
