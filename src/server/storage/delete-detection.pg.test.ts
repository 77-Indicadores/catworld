/**
 * Deteccao de exclusoes (escopo, fullSnapshot, verificacao de chaves, revive, conversao legada e purga de lapides)
 * contra Postgres REAL. So roda com CW_TEST_PG_URL (Postgres descartavel — NUNCA producao).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

vi.mock("@/server/db", () => ({ prisma: {} }));

import { PgStorageConnection } from "./pg-storage";
import { tombstoneTableName } from "./delete-detection";

const url = process.env.CW_TEST_PG_URL;
const d = url ? describe : describe.skip;

const SCHEMA = "dd_test";
const COLS = [
  { name: "k", sqlType: "NVARCHAR(MAX)", nullable: true },
  { name: "g", sqlType: "NVARCHAR(MAX)", nullable: true },
  { name: "v", sqlType: "NVARCHAR(MAX)", nullable: true },
];

d("deteccao de exclusoes (Postgres real)", () => {
  const pool = new Pool({ connectionString: url });
  const conn = new PgStorageConnection("test", url!);

  const q = (sql: string, p?: unknown[]) => pool.query(sql, p);
  const keys = async (t: string) => (await q(`SELECT k FROM ${SCHEMA}.${t} ORDER BY k`)).rows.map(r => r.k);
  const tombKeys = async (t: string) => (await q(`SELECT cw_key FROM ${SCHEMA}.${tombstoneTableName(t)} ORDER BY cw_key`).catch(() => ({ rows: [] }))).rows.map(r => r.cw_key);

  /** target com as colunas de controle + staging so com as colunas de dados. */
  async function setup(target: [string, string | null, string][], stage: [string, string | null, string][]) {
    await q(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};
      CREATE TABLE ${SCHEMA}.t (k text, g text, v text, cw_synced_at timestamp NOT NULL DEFAULT now(), cw_deleted_at timestamp NULL);
      CREATE TABLE ${SCHEMA}.s (k text, g text, v text)`);
    for (const r of target) await q(`INSERT INTO ${SCHEMA}.t (k,g,v) VALUES ($1,$2,$3)`, r);
    for (const r of stage) await q(`INSERT INTO ${SCHEMA}.s (k,g,v) VALUES ($1,$2,$3)`, r);
  }
  const swap = (opts: Parameters<PgStorageConnection["atomicSwap"]>[4]) =>
    conn.atomicSwap(SCHEMA, "s", "t", COLS, { targetExists: true, keyColumn: "k", mergedName: "m", ...opts });

  beforeAll(async () => { await q(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`); });
  afterAll(async () => { await q(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); await pool.end(); await conn._pool.end(); });
  beforeEach(async () => { await q(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`); });

  it("escopo: remove so o que falta num grupo relido; preserva outros grupos e escopo nulo", async () => {
    await setup([["1", "A", "x"], ["2", "A", "x"], ["3", "B", "x"], ["4", null, "x"]], [["1", "A", "y"]]);
    const r = await swap({ scopeColumns: ["g"] });
    expect(r.removed).toBe(1);
    expect(await keys("t")).toEqual(["1", "3", "4"]);
    expect(await tombKeys("t")).toEqual(["2"]);
    expect((await q(`SELECT v FROM ${SCHEMA}.t WHERE k='1'`)).rows[0].v).toBe("y");
  });

  it("sem escopo configurado o delta parcial nao remove nada (comportamento anterior)", async () => {
    await setup([["1", "A", "x"], ["2", "A", "x"]], [["1", "A", "y"]]);
    const r = await swap({});
    expect(r.removed).toBe(0);
    expect(await keys("t")).toEqual(["1", "2"]);
    expect(await tombKeys("t")).toEqual([]);
  });

  it("fullSnapshot remove fisicamente tudo que a staging nao tem e guarda a lapide", async () => {
    await setup([["1", "A", "x"], ["2", "A", "x"], ["3", "B", "x"]], [["1", "A", "y"]]);
    const r = await swap({ fullSnapshot: true });
    expect(r.removed).toBe(2);
    expect(await keys("t")).toEqual(["1"]);
    expect(await tombKeys("t")).toEqual(["2", "3"]);
  });

  it("revive: chave que volta na origem perde a lapide e volta a existir", async () => {
    await setup([["1", "A", "x"], ["2", "A", "x"]], [["1", "A", "y"]]);
    await swap({ scopeColumns: ["g"] });
    expect(await tombKeys("t")).toEqual(["2"]);
    await q(`DROP TABLE IF EXISTS ${SCHEMA}.s; CREATE TABLE ${SCHEMA}.s (k text, g text, v text); INSERT INTO ${SCHEMA}.s VALUES ('1','A','y'),('2','A','z')`);
    await swap({ scopeColumns: ["g"] });
    expect(await tombKeys("t")).toEqual([]);
    expect(await keys("t")).toContain("2");
  });

  it("verificacao de chaves: remove ausentes, respeita cw_synced_at >= before e a trava de proporcao", async () => {
    await setup([], []);
    for (let i = 1; i <= 100; i++) await q(`INSERT INTO ${SCHEMA}.t (k,g,v,cw_synced_at) VALUES ($1,'A','x', now() - interval '1 hour')`, [String(i)]);
    await q(`UPDATE ${SCHEMA}.t SET cw_synced_at = now() + interval '1 hour' WHERE k = '95'`); // carregada depois do snapshot
    await q(`CREATE TABLE ${SCHEMA}.kk (k text)`);
    for (let i = 1; i <= 90; i++) await q(`INSERT INTO ${SCHEMA}.kk VALUES ($1)`, [String(i)]);
    const before = await conn.serverNow();

    // 10 candidatas (91..100) mas a 95 e protegida => 9 removidas; proporcao 9% < 30%
    const r = await conn.markMissingKeysDeleted(SCHEMA, "t", "k", "kk", before);
    expect(r).toMatchObject({ aborted: false, marked: 9 });
    expect(await keys("t")).toContain("95");
    expect((await tombKeys("t")).length).toBe(9);

    // trava: lista de chaves quase vazia => candidatas > 30% => aborta sem remover
    await q(`TRUNCATE ${SCHEMA}.kk; INSERT INTO ${SCHEMA}.kk VALUES ('1')`);
    const before2 = await conn.serverNow();
    const r2 = await conn.markMissingKeysDeleted(SCHEMA, "t", "k", "kk", before2);
    expect(r2.aborted).toBe(true);
    expect(r2.marked).toBe(0);
    expect((await keys("t")).length).toBe(91);
  });

  it("conversao legada: soft delete vira lapide + remocao fisica, e e idempotente", async () => {
    await setup([["1", "A", "x"], ["2", "A", "x"], ["3", "A", "x"]], []);
    await q(`UPDATE ${SCHEMA}.t SET cw_deleted_at = now() - interval '2 days' WHERE k IN ('2','3')`);
    expect(await conn.convertLegacyDeleted(SCHEMA, "t", "k")).toBe(2);
    expect(await keys("t")).toEqual(["1"]);
    expect(await tombKeys("t")).toEqual(["2", "3"]);
    expect(await conn.convertLegacyDeleted(SCHEMA, "t", "k")).toBe(0);
  });

  it("purga so lapides mais antigas que a validade; 0 dias nao apaga nada", async () => {
    await setup([["1", "A", "x"]], []);
    await conn.ensureTombstoneTable(SCHEMA, "t", "NVARCHAR(MAX)");
    const tomb = `${SCHEMA}.${tombstoneTableName("t")}`;
    await q(`INSERT INTO ${tomb} VALUES ('old', now() - interval '40 days'), ('new', now() - interval '1 day')`);
    expect(await conn.purgeTombstones(SCHEMA, "t", 0)).toBe(0);
    expect(await conn.purgeTombstones(SCHEMA, "t", 30)).toBe(1);
    expect(await tombKeys("t")).toEqual(["new"]);
  });
});
