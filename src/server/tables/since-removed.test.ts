import { describe, expect, it } from "vitest";
import { pgRemovedSql, removedIncomplete, removedKeysSql, REMOVED_CAP } from "./since";

const base = { qTarget: '"s"."t"', qDeleted: '"cw_deleted_at"', qKey: '"id"', sinceLit: "'2026-01-01 00:00:00'" };

describe("removedKeysSql", () => {
  it("sem lapide: so o formato legado (cw_deleted_at)", () => {
    const sql = removedKeysSql(base);
    expect(sql).toContain('FROM "s"."t" WHERE "cw_deleted_at" > \'2026-01-01 00:00:00\'');
    expect(sql).not.toContain("UNION");
  });

  it("com lapide: une a lapide (deleted_at > since) ao legado", () => {
    const sql = removedKeysSql({ ...base, qTomb: '"s"."cw_tomb_t"', qTombKey: '"cw_key"', qTombAt: '"cw_deleted_at"' });
    expect(sql).toContain('SELECT "cw_key" AS k, "cw_deleted_at" AS d FROM "s"."cw_tomb_t" WHERE "cw_deleted_at" > \'2026-01-01 00:00:00\'');
    expect(sql).toContain("UNION ALL");
    expect(sql).toContain('FROM "s"."t" WHERE "cw_deleted_at"');
    expect(sql).toContain("ORDER BY d ASC, k ASC");
  });

  it("pg aplica o teto de REMOVED_CAP + 1", () => {
    expect(pgRemovedSql(base)).toMatch(new RegExp(`LIMIT ${REMOVED_CAP + 1}$`));
  });
});

describe("removedIncomplete", () => {
  const now = new Date("2026-06-30T00:00:00Z");
  it("since mais antigo que a validade sinaliza ressincronizacao", () => {
    expect(removedIncomplete(new Date("2026-05-01T00:00:00Z"), 30, now)).toBe(true);
    expect(removedIncomplete(new Date("2026-06-20T00:00:00Z"), 30, now)).toBe(false);
  });
  it("validade 0 = lapides nunca expiram", () => {
    expect(removedIncomplete(new Date("2020-01-01T00:00:00Z"), 0, now)).toBe(false);
  });
});
