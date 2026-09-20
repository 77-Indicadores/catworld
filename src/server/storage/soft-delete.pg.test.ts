/**
 * Soft delete (marcar/desmarcar por lista de chaves, guarda cw_synced_at, fullSnapshot, RLS) contra Postgres REAL.
 * So roda com CW_TEST_PG_URL (Postgres descartavel — NUNCA producao). O usuario da URL precisa poder criar papeis.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

vi.mock("@/server/db", () => ({ prisma: {} }));

import { PgStorageConnection } from "./pg-storage";

const url = process.env.CW_TEST_PG_URL;
const d = url ? describe : describe.skip;

const SCHEMA = "sd_test";
const READER = "cw_sd_reader";
const COLS = [
  { name: "k", sqlType: "NVARCHAR(MAX)", nullable: true },
  { name: "v", sqlType: "NVARCHAR(MAX)", nullable: true },
];

d("soft delete (Postgres real)", () => {
  const pool = new Pool({ connectionString: url });
  const conn = new PgStorageConnection("test-sd", url!);
  const q = (sql: string, p?: unknown[]) => pool.query(sql, p);

  const live = async () => (await q(`SELECT k FROM ${SCHEMA}.t WHERE cw_deleted_at IS NULL ORDER BY k`)).rows.map(r => r.k);
  const marked = async () => (await q(`SELECT k FROM ${SCHEMA}.t WHERE cw_deleted_at IS NOT NULL ORDER BY k`)).rows.map(r => r.k);
  const all = async () => (await q(`SELECT k FROM ${SCHEMA}.t ORDER BY k`)).rows.map(r => r.k);

  async function setup(target: [string, string][], stage: [string, string][], keys: string[] | null) {
    await q(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};
      CREATE TABLE ${SCHEMA}.t (k text, v text, cw_synced_at timestamp NOT NULL DEFAULT now(), cw_deleted_at timestamp NULL);
      CREATE TABLE ${SCHEMA}.s (k text, v text)`);
    // linhas do target sincronizadas ha 1 hora (antes de qualquer keysBefore)
    for (const r of target) await q(`INSERT INTO ${SCHEMA}.t (k,v,cw_synced_at) VALUES ($1,$2, now() - interval '1 hour')`, r);
    for (const r of stage) await q(`INSERT INTO ${SCHEMA}.s (k,v) VALUES ($1,$2)`, r);
    if (keys) {
      await q(`CREATE TABLE ${SCHEMA}.kk (k text)`);
      for (const k of keys) await q(`INSERT INTO ${SCHEMA}.kk VALUES ($1)`, [k]);
    }
  }
  const swap = async (opts: Record<string, unknown> = {}) =>
    conn.atomicSwap(SCHEMA, "s", "t", COLS, { targetExists: true, keyColumn: "k", mergedName: "m", ...opts });
  const withKeys = async (opts: Record<string, unknown> = {}) =>
    swap({ keysTable: "kk", keysBefore: await conn.serverNow(), ...opts });

  beforeAll(async () => {
    await q(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${READER}') THEN CREATE ROLE ${READER} NOLOGIN; END IF; END $$`);
    await q(`GRANT ${READER} TO CURRENT_USER`).catch(() => undefined);
  });
  afterAll(async () => {
    await q(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await q(`DROP ROLE IF EXISTS ${READER}`).catch(() => undefined);
    await pool.end();
    await conn._pool.end();
  });
  beforeEach(async () => { await q(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`); });

  it("marca: chave fora da lista (ausente da staging) fica preservada com cw_deleted_at", async () => {
    await setup([["1", "x"], ["2", "x"], ["3", "x"]], [["1", "y"]], ["1", "3"]);
    const r = await withKeys();
    expect(r.marked).toBe(1);
    expect(await all()).toEqual(["1", "2", "3"]);
    expect(await marked()).toEqual(["2"]);
    expect((await q(`SELECT v FROM ${SCHEMA}.t WHERE k='1'`)).rows[0].v).toBe("y");
  });

  it("desmarca: chave na lista (fora do delta) perde a marca; revive pela staging tambem; segunda marca preserva o carimbo", async () => {
    await setup([["1", "x"], ["2", "x"], ["3", "x"]], [], ["1", "2", "3"]);
    await q(`UPDATE ${SCHEMA}.t SET cw_deleted_at = now() - interval '2 days' WHERE k IN ('2','3')`);
    await q(`UPDATE ${SCHEMA}.kk SET k = k`); // no-op
    await q(`DELETE FROM ${SCHEMA}.kk WHERE k = '3'`); // 3 continua excluida, 2 existe na origem
    await q(`INSERT INTO ${SCHEMA}.s VALUES ('9','n')`);
    const stamp = (await q(`SELECT cw_deleted_at FROM ${SCHEMA}.t WHERE k='3'`)).rows[0].cw_deleted_at;
    const r = await withKeys();
    expect(r.marked).toBe(0); // 3 ja estava marcada: nao conta como nova
    expect(await marked()).toEqual(["3"]);
    expect((await q(`SELECT cw_deleted_at FROM ${SCHEMA}.t WHERE k='3'`)).rows[0].cw_deleted_at).toEqual(stamp); // carimbo preservado
    // 2 voltou a viver e cw_synced_at foi atualizado (consumidor de since ve a mudanca)
    expect((await q(`SELECT cw_synced_at > now() - interval '10 minutes' AS fresh FROM ${SCHEMA}.t WHERE k='2'`)).rows[0].fresh).toBe(true);

    // revive via staging
    await q(`DROP TABLE IF EXISTS ${SCHEMA}.s; CREATE TABLE ${SCHEMA}.s (k text, v text); INSERT INTO ${SCHEMA}.s VALUES ('3','z')`);
    await swap();
    expect(await marked()).toEqual([]);
  });

  it("guarda cw_synced_at: linha sincronizada depois de keysBefore nao e marcada", async () => {
    await setup([["1", "x"], ["2", "x"]], [], ["1"]);
    const before = await conn.serverNow();
    await q(`UPDATE ${SCHEMA}.t SET cw_synced_at = now() + interval '1 hour' WHERE k = '2'`);
    const r = await swap({ keysTable: "kk", keysBefore: before });
    expect(r.marked).toBe(0);
    expect(await marked()).toEqual([]);
  });

  it("sem keysTable: comportamento antigo (delta parcial nao marca nada)", async () => {
    await setup([["1", "x"], ["2", "x"]], [["1", "y"]], null);
    const r = await swap();
    expect(r.marked).toBe(0);
    expect(await marked()).toEqual([]);
    expect(await all()).toEqual(["1", "2"]);
  });

  it("countMissingKeys: candidatas e vivas (marcadas nao contam)", async () => {
    await setup([["1", "x"], ["2", "x"], ["3", "x"], ["4", "x"]], [], ["1", "2"]);
    await q(`UPDATE ${SCHEMA}.t SET cw_deleted_at = now() WHERE k = '4'`);
    const before = await conn.serverNow();
    expect(await conn.countMissingKeys(SCHEMA, "t", "k", "kk", before)).toEqual({ live: 3, candidates: 1 });
    expect(await conn.countRows(SCHEMA, "t")).toBe(3n);
  });

  it("fullSnapshot: ramo original marca (soft) toda chave ausente da staging", async () => {
    await setup([["1", "x"], ["2", "x"], ["3", "x"]], [["1", "y"]], null);
    const r = await swap({ fullSnapshot: true });
    expect(r.marked).toBe(2);
    expect(await all()).toEqual(["1", "2", "3"]);
    expect(await marked()).toEqual(["2", "3"]);
    // idempotente: segunda rodada nao remarca
    await q(`DROP TABLE IF EXISTS ${SCHEMA}.s; CREATE TABLE ${SCHEMA}.s (k text, v text); INSERT INTO ${SCHEMA}.s VALUES ('1','y')`);
    expect((await swap({ fullSnapshot: true })).marked).toBe(0);
  });

  it("RLS: papel NOLOGIN so ve linhas nao marcadas, o dono ve tudo; a politica sobrevive a novo swap", async () => {
    await setup([["1", "x"], ["2", "x"], ["3", "x"]], [["1", "y"]], ["1", "3"]);
    await withKeys();
    await q(`GRANT USAGE ON SCHEMA ${SCHEMA} TO ${READER}; GRANT SELECT ON ALL TABLES IN SCHEMA ${SCHEMA} TO ${READER}`);

    const asReader = async () => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN READ ONLY");
        await c.query(`SET LOCAL ROLE ${READER}`);
        return (await c.query(`SELECT k FROM ${SCHEMA}.t ORDER BY k`)).rows.map(r => r.k);
      } finally { await c.query("ROLLBACK").catch(() => undefined); c.release(); }
    };
    expect(await asReader()).toEqual(["1", "3"]);
    expect(await all()).toEqual(["1", "2", "3"]); // dono/admin continua vendo a marcada

    // segundo swap: DROP TABLE perdeu a politica, deve ter sido reaplicada
    await q(`DROP TABLE IF EXISTS ${SCHEMA}.s; CREATE TABLE ${SCHEMA}.s (k text, v text); INSERT INTO ${SCHEMA}.s VALUES ('1','z')`);
    await q(`DROP TABLE IF EXISTS ${SCHEMA}.kk; CREATE TABLE ${SCHEMA}.kk (k text); INSERT INTO ${SCHEMA}.kk VALUES ('1'), ('2')`);
    const r2 = await withKeys();
    expect(r2.marked).toBe(1); // 3 saiu da lista
    await q(`GRANT SELECT ON ALL TABLES IN SCHEMA ${SCHEMA} TO ${READER}`); // tabela recriada (em producao: DEFAULT PRIVILEGES)
    expect(await asReader()).toEqual(["1", "2"]);
    expect(await marked()).toEqual(["3"]);
    const pol = await q(`SELECT polname FROM pg_policy WHERE polrelid = '${SCHEMA}.t'::regclass`);
    expect(pol.rows.map(r => r.polname)).toEqual(["cw_hide_deleted"]);
    const rls = await q(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = '${SCHEMA}.t'::regclass`);
    expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: false });
  });
});
