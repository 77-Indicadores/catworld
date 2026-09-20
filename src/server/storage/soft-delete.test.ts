import { beforeEach, describe, expect, it, vi } from "vitest";

const pg = vi.hoisted(() => {
  const sqls: { sql: string; params?: unknown[] }[] = [];
  type R = { rows: Record<string, unknown>[]; rowCount: number };
  const query = vi.fn(async (sql: string, params?: unknown[]): Promise<R> => {
    sqls.push({ sql, params });
    if (sql.includes("information_schema.columns")) return { rows: ["id", "a", "cw_deleted_at"].map(column_name => ({ column_name })), rowCount: 3 };
    if (sql.includes("COUNT(*)::text AS n")) return { rows: [{ n: "4" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
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
import { carryPlan, keysCheckExceeds, missingKeysWhere } from "./delete-detection";

const cols = [
  { name: "id", sqlType: "BIGINT", nullable: true },
  { name: "a", sqlType: "NVARCHAR(MAX)", nullable: true },
];
const all = () => pg.sqls.map(s => s.sql);
const copyOf = () => pg.sqls.find(s => s.sql.includes('INSERT INTO "sc"."mgd"') && s.sql.includes('FROM "sc"."tgt" t'))!;

describe("PgStorageConnection.atomicSwap - soft delete por lista de chaves", () => {
  beforeEach(() => { pg.sqls.length = 0; pg.query.mockClear(); });

  it("com keysTable: preserva ausentes, desmarca chave na lista, marca fora dela (guarda cw_synced_at) e devolve marked", async () => {
    const conn = new PgStorageConnection("t-sd-1", "postgres://u:p@h/db");
    const before = new Date("2026-01-01T00:00:00Z");
    const res = await conn.atomicSwap("sc", "stg", "tgt", cols, { keyColumn: "id", mergedName: "mgd", keysTable: "keys", keysBefore: before });
    expect(res).toEqual({ marked: 4 });
    const copy = copyOf();
    expect(copy.params).toEqual([before]);
    expect(copy.sql).toContain('EXISTS (SELECT 1 FROM "sc"."keys" k WHERE k."id" = t."id")');
    expect(copy.sql).toContain('t."cw_synced_at" < $1::timestamp');
    expect(copy.sql).toContain('WHEN EXISTS (SELECT 1 FROM "sc"."keys" k WHERE k."id" = t."id") THEN NULL'); // desmarca
    expect(copy.sql).toContain('COALESCE(t."cw_deleted_at", now())');
    expect(copy.sql).toContain('NOT EXISTS (SELECT 1 FROM "sc"."stg" s WHERE s."id" = t."id")');
    expect(copy.sql).not.toContain("1 = 0"); // nunca remove
  });

  it("sem keysTable (delta parcial): copia como esta, sem marcar nem contar", async () => {
    const conn = new PgStorageConnection("t-sd-2", "postgres://u:p@h/db");
    const res = await conn.atomicSwap("sc", "stg", "tgt", cols, { keyColumn: "id", mergedName: "mgd" });
    expect(res.marked).toBe(0);
    expect(copyOf().sql).toContain('SELECT t."id", t."a", t."cw_synced_at", t."cw_deleted_at"');
    expect(all().some(s => s.includes("COUNT(*)::text AS n"))).toBe(false);
  });

  it("fullSnapshot: ramo original (carimba se viva) e ignora keysTable", async () => {
    const conn = new PgStorageConnection("t-sd-3", "postgres://u:p@h/db");
    await conn.atomicSwap("sc", "stg", "tgt", cols, { keyColumn: "id", mergedName: "mgd", fullSnapshot: true, keysTable: "keys", keysBefore: new Date() });
    const copy = copyOf();
    expect(copy.sql).toContain('CASE WHEN t."cw_deleted_at" IS NULL THEN now() ELSE t."cw_deleted_at" END');
    expect(copy.sql).not.toContain('"sc"."keys"');
  });

  it("aplica RLS (reaplicada) na mesma transacao, depois do rename, sem FORCE", async () => {
    const conn = new PgStorageConnection("t-sd-4", "postgres://u:p@h/db");
    await conn.atomicSwap("sc", "stg", "tgt", cols, { keyColumn: "id", mergedName: "mgd" });
    const s = all();
    const begin = s.indexOf("BEGIN");
    const rename = s.findIndex(x => x.startsWith('ALTER TABLE "sc"."mgd" RENAME'));
    const enable = s.indexOf('ALTER TABLE "sc"."tgt" ENABLE ROW LEVEL SECURITY');
    const policy = s.findIndex(x => x.includes("CREATE POLICY cw_hide_deleted") && x.includes('"cw_deleted_at" IS NULL'));
    const commit = s.indexOf("COMMIT");
    expect(begin).toBeLessThan(rename);
    expect(rename).toBeLessThan(enable);
    expect(enable).toBeLessThan(policy);
    expect(policy).toBeLessThan(commit);
    expect(s.join("\n")).not.toContain("FORCE ROW LEVEL SECURITY");
  });

  it("swap sem chave (full replace) tambem reaplica a politica", async () => {
    const conn = new PgStorageConnection("t-sd-5", "postgres://u:p@h/db");
    await conn.atomicSwap("sc", "stg", "tgt", cols, { keyColumn: null });
    expect(all().some(x => x.includes('CREATE POLICY cw_hide_deleted ON "sc"."tgt"'))).toBe(true);
  });

  it("countMissingKeys conta so linhas vivas com guarda de sincronizacao", async () => {
    pg.query.mockImplementationOnce(async (sql: string, params?: unknown[]) => { pg.sqls.push({ sql, params }); return { rows: [{ live: "100", candidates: "7" }], rowCount: 1 }; });
    const conn = new PgStorageConnection("t-sd-6", "postgres://u:p@h/db");
    const before = new Date();
    expect(await conn.countMissingKeys("sc", "tgt", "id", "keys", before)).toEqual({ live: 100, candidates: 7 });
    expect(pg.sqls[0]!.sql).toContain('t."cw_deleted_at" IS NULL');
    expect(pg.sqls[0]!.sql).toContain('"cw_synced_at" < $1::timestamp');
    expect(pg.sqls[0]!.params).toEqual([before]);
  });

  it("countRows so conta vivas quando a coluna existe", async () => {
    pg.query.mockImplementationOnce(async (sql: string, params?: unknown[]) => { pg.sqls.push({ sql, params }); return { rows: [{ x: 1 }], rowCount: 1 }; });
    const conn = new PgStorageConnection("t-sd-7", "postgres://u:p@h/db");
    await conn.countRows("sc", "tgt");
    expect(pg.sqls[1]!.sql).toContain('WHERE "cw_deleted_at" IS NULL');
  });
});

describe("carryPlan / guardas (compartilhados pg + mssql)", () => {
  const q = (id: string) => `[${id}]`;
  it("mssql: parametro @before e SYSUTCDATETIME", () => {
    const p = carryPlan({ q, qStg: "[s].[stg]", key: "[id]", qSyncedAt: "[cw_synced_at]", qDeletedAt: "[cw_deleted_at]", now: "SYSUTCDATETIME()", fullSnapshot: false, qKeys: "[s].[keys]", beforeParam: "@before" });
    expect(p.deletedAtExpr).toContain("WHEN t.[cw_synced_at] < @before THEN COALESCE(t.[cw_deleted_at], SYSUTCDATETIME())");
    expect(p.deletedAtExpr).toContain("THEN NULL");
    expect(p.markedWhere).toContain("t.[cw_deleted_at] IS NULL AND t.[cw_synced_at] < @before AND NOT EXISTS");
  });
  it("sem keys e sem fullSnapshot: copia como esta", () => {
    const p = carryPlan({ q, qStg: "s", key: "[id]", qSyncedAt: "[a]", qDeletedAt: "[b]", now: "now()", fullSnapshot: false });
    expect(p).toEqual({ syncedAtExpr: "t.[a]", deletedAtExpr: "t.[b]", markedWhere: null });
  });
  it("fullSnapshot preserva carimbo existente", () => {
    const p = carryPlan({ q, qStg: "s", key: "[id]", qSyncedAt: "[a]", qDeletedAt: "[b]", now: "now()", fullSnapshot: true });
    expect(p.deletedAtExpr).toBe("CASE WHEN t.[b] IS NULL THEN now() ELSE t.[b] END");
  });
  it("missingKeysWhere e keysCheckExceeds", () => {
    expect(missingKeysWhere({ q, qKeys: "[k]", key: "[id]", beforeParam: "@b" })).toContain("t.[cw_synced_at] < @b");
    expect(keysCheckExceeds({ candidates: 40, live: 100 })).toBe(true);
    expect(keysCheckExceeds({ candidates: 30, live: 100 })).toBe(false);
    expect(keysCheckExceeds({ candidates: 40, live: 49 })).toBe(false); // tabela minuscula: nao avalia
    expect(keysCheckExceeds({ candidates: 0, live: 100 })).toBe(false);
  });
});
