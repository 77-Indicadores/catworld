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

  it("H4: merge com _cw_rh preserva cw_synced_at da linha que nao mudou e carimba a que mudou / a nova", async () => {
    const hcols = [{ name: "id", sqlType: "BIGINT", nullable: false }, { name: "v", sqlType: "NVARCHAR(MAX)", nullable: true }, { name: "_cw_rh", sqlType: "NVARCHAR(MAX)", nullable: true }];
    const load = async (rows: [number, string, string][], exists: boolean) => {
      await admin.query(`DROP TABLE IF EXISTS ${S}.stg_h`);
      await admin.query(`CREATE TABLE ${S}.stg_h (id bigint NOT NULL, v text, _cw_rh text)`);
      for (const r of rows) await admin.query(`INSERT INTO ${S}.stg_h VALUES ($1,$2,$3)`, r);
      await conn.atomicSwap(S, "stg_h", "t_h", hcols as never, { targetExists: exists, keyColumn: "id", mergedName: "mgd_h" });
    };
    const stamps = async () => Object.fromEntries((await admin.query(`SELECT id::text, cw_synced_at FROM ${S}.t_h`)).rows.map((r: { id: string; cw_synced_at: Date }) => [r.id, r.cw_synced_at.getTime()]));
    await load([[1, "a", "h1"], [2, "b", "h2"]], false);
    const first = await stamps();
    await new Promise((r) => setTimeout(r, 1100));
    await load([[1, "a", "h1"], [2, "b2", "h2x"], [3, "c", "h3"]], true);
    const second = await stamps();
    expect(second["1"]).toBe(first["1"]);            // conteudo igual: carimbo preservado
    expect(second["2"]).toBeGreaterThan(first["2"]); // mudou: carimbo novo
    expect(second["3"]).toBeGreaterThan(first["2"]); // nova: carimbo novo
  });

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
