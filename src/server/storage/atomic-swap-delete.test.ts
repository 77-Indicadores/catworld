import { beforeEach, describe, expect, it, vi } from "vitest";

const pg = vi.hoisted(() => {
  const sqls: string[] = [];
  type R = { rows: Record<string, unknown>[]; rowCount: number };
  const query = vi.fn(async (sql: string): Promise<R> => {
    sqls.push(sql);
    if (sql.includes("information_schema.columns")) return { rows: ["id", "a", "b", "v"].map(column_name => ({ column_name })), rowCount: 4 };
    if (sql.includes("information_schema.tables")) return { rows: [{ exists: true }], rowCount: 1 };
    return { rows: [], rowCount: 2 };
  });
  return { sqls, query };
});

vi.mock("pg", () => {
  class Pool {
    on() {}
    query = pg.query;
    async connect() { return { query: pg.query, release() {} }; }
  }
  return { Pool };
});

import { PgStorageConnection } from "./pg-storage";

const cols = [
  { name: "id", sqlType: "BIGINT", nullable: true },
  { name: "a", sqlType: "NVARCHAR(MAX)", nullable: true },
  { name: "b", sqlType: "NVARCHAR(MAX)", nullable: true },
  { name: "v", sqlType: "NVARCHAR(MAX)", nullable: true },
];

describe("PgStorageConnection.atomicSwap - remocao com lapide", () => {
  beforeEach(() => { pg.sqls.length = 0; pg.query.mockClear(); });

  it("escopo: fora do escopo preservadas, do escopo removidas e na lapide, dentro da transacao do swap", async () => {
    const conn = new PgStorageConnection("t-pg-1", "postgres://u:p@h/db");
    const res = await conn.atomicSwap("sc", "stg", "tgt", cols, { keyColumn: "id", mergedName: "mgd", scopeColumns: ["a", "b"] });
    expect(res.removed).toBe(2);
    const copy = pg.sqls.find(s => s.includes('INSERT INTO "sc"."mgd"') && s.includes('FROM "sc"."tgt" t'))!;
    expect(copy).toContain("LEFT JOIN (SELECT DISTINCT");
    expect(copy).toContain('sc."a" IS NULL'); // preserva escopo ausente/nulo
    expect(copy).toContain('t."cw_deleted_at"');
    const begin = pg.sqls.indexOf("BEGIN");
    const commit = pg.sqls.indexOf("COMMIT");
    const tomb = pg.sqls.findIndex(s => s.startsWith('INSERT INTO "sc"."cw_tomb_tgt"'));
    const revive = pg.sqls.findIndex(s => s.startsWith('DELETE FROM "sc"."cw_tomb_tgt"'));
    const drop = pg.sqls.findIndex(s => s.startsWith('DROP TABLE "sc"."tgt"'));
    expect(begin).toBeLessThan(revive);
    expect(revive).toBeLessThan(tomb);
    expect(tomb).toBeLessThan(drop);
    expect(drop).toBeLessThan(commit);
    expect(pg.sqls.some(s => s.includes("CREATE TABLE IF NOT EXISTS") && s.includes("cw_tomb_tgt"))).toBe(true);
  });

  it("fullSnapshot: nenhuma linha ausente e copiada", async () => {
    const conn = new PgStorageConnection("t-pg-2", "postgres://u:p@h/db");
    await conn.atomicSwap("sc", "stg", "tgt", cols, { keyColumn: "id", mergedName: "mgd", fullSnapshot: true });
    const copy = pg.sqls.find(s => s.includes('FROM "sc"."tgt" t') && s.includes('INSERT INTO "sc"."mgd"'))!;
    expect(copy).toContain("1 = 0");
    expect(pg.sqls.some(s => s.startsWith('INSERT INTO "sc"."cw_tomb_tgt"'))).toBe(true);
  });

  it("delta parcial sem escopo: nenhuma lapide gravada nem tabela criada", async () => {
    const conn = new PgStorageConnection("t-pg-3", "postgres://u:p@h/db");
    const res = await conn.atomicSwap("sc", "stg", "tgt", cols, { keyColumn: "id", mergedName: "mgd" });
    expect(res.removed).toBe(0);
    expect(pg.sqls.some(s => s.startsWith('INSERT INTO "sc"."cw_tomb_tgt"'))).toBe(false);
    expect(pg.sqls.some(s => s.includes("CREATE TABLE IF NOT EXISTS"))).toBe(false);
  });
});

describe("PgStorageConnection.markMissingKeysDeleted", () => {
  beforeEach(() => { pg.sqls.length = 0; pg.query.mockClear(); });

  it("conta antes; acima do limite aborta sem remover", async () => {
    pg.query.mockImplementationOnce(async (sql: string) => { pg.sqls.push(sql); return { rows: [{ live: "100", candidates: "60" }], rowCount: 1 }; });
    const conn = new PgStorageConnection("t-pg-4", "postgres://u:p@h/db");
    const r = await conn.markMissingKeysDeleted("sc", "tgt", "id", "keys", new Date(), { maxRatio: 0.3 });
    expect(r).toMatchObject({ aborted: true, marked: 0, candidates: 60, live: 100 });
    expect(pg.sqls.some(s => s.startsWith("WITH del AS"))).toBe(false);
    expect(pg.sqls[0]).toContain('"cw_synced_at" < $1::timestamp');
  });

  it("dentro do limite remove com lapide na mesma instrucao", async () => {
    pg.query
      .mockImplementationOnce(async (sql: string) => { pg.sqls.push(sql); return { rows: [{ live: "100", candidates: "5" }], rowCount: 1 }; })
      .mockImplementationOnce(async (sql: string) => { pg.sqls.push(sql); return { rows: [{ column_name: "id", data_type: "bigint", is_nullable: "YES" }], rowCount: 1 }; });
    const conn = new PgStorageConnection("t-pg-5", "postgres://u:p@h/db");
    const r = await conn.markMissingKeysDeleted("sc", "tgt", "id", "keys", new Date());
    expect(r.aborted).toBe(false);
    const del = pg.sqls.find(s => s.startsWith("WITH del AS"))!;
    expect(del).toContain('NOT EXISTS (SELECT 1 FROM "sc"."keys" k WHERE k."id" = t."id")');
    expect(del).toContain('"cw_synced_at" < $1::timestamp');
    expect(del).toContain('INSERT INTO "sc"."cw_tomb_tgt"');
  });
});
