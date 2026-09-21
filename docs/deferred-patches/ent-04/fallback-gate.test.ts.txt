import { beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

const state = { mode: undefined as string | undefined };
vi.mock("@/server/db", () => ({
  prisma: { $queryRawUnsafe: vi.fn(async () => (state.mode ? [{ value: state.mode }] : [])) },
}));

import { legacyGate } from "./fallback-gate";

async function fresh() {
  vi.resetModules();
  return import("./apply");
}

class PgError extends Error {
  constructor(message: string, public code: string) { super(message); }
}

beforeEach(() => {
  state.mode = undefined; // padrao = fallback
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("legacyGate (o que o tradutor antigo faz diferente do SQL Server)", () => {
  it.each([
    ["LIKE", "SELECT a::text FROM t WHERE n LIKE 'x%'"],
    ["mes", "SELECT DATEADD(month, 1, d) FROM t"],
    ["ano", "SELECT DATEDIFF(yy, a, b) FROM t"],
    ["CHARINDEX", "SELECT CHARINDEX('a', b) FROM t"],
    ["varchar(n)", "SELECT CAST(a AS VARCHAR(3)) FROM t"],
    ["TRY_CAST", "SELECT TRY_CAST(a AS INT) FROM t"],
  ])("bloqueia %s", (_l, q) => expect(legacyGate(q).block).toBeTruthy());
  it("palavras dentro de literais nao contam", () => {
    expect(legacyGate("SELECT 'LIKE x' AS s, a::text FROM t").block).toBeNull();
  });
  it("ORDER BY / LEN / ISNULL so avisam", () => {
    const g = legacyGate("SELECT ISNULL(a,0), LEN(b) FROM t ORDER BY a");
    expect(g.block).toBeNull();
    expect(g.warn).toHaveLength(3);
  });
});

describe("runWithContract fallback (ENT-04)", () => {
  const ok = (rows: unknown[] = []) => vi.fn(async (t: { sql: string }) => ({ rows, sql: t.sql } as { rows: unknown[]; sql: string; warnings?: string[] }));

  it("motor novo aceita: sem aviso, sem legado", async () => {
    const { runWithContract } = await fresh();
    const exec = ok();
    const r = await runWithContract("SELECT TOP 1 a FROM t", "postgres", "storage-pg", "regex", exec);
    expect(r.warnings).toBeUndefined();
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("motor novo rejeita e o legado e equivalente: usa o legado E avisa LEGACY_TRANSLATION", async () => {
    const { runWithContract } = await fresh();
    const exec = ok();
    const r = await runWithContract("SELECT a::text FROM t", "postgres", "storage-pg", "regex", exec);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(r.warnings?.[0]).toMatch(/^LEGACY_TRANSLATION:/);
  });

  it("avisa tambem as diferencas de borda (ORDER BY: ordem de NULL)", async () => {
    const { runWithContract } = await fresh();
    const r = await runWithContract("SELECT a::text FROM t ORDER BY a", "postgres", "storage-pg", "regex", ok());
    expect(r.warnings?.[0]).toMatch(/ordem de NULL/);
  });

  it("motor novo rejeita e o legado MUDARIA o resultado (LIKE): NAO executa; UNSUPPORTED_CONSTRUCT com o motivo", async () => {
    const { runWithContract } = await fresh();
    const exec = ok();
    await expect(runWithContract("SELECT a::text FROM t WHERE n LIKE 'x%'", "postgres", "storage-pg", "regex", exec)).rejects.toMatchObject({
      code: "UNSUPPORTED_CONSTRUCT",
      message: expect.stringContaining("LIKE"),
    });
    expect(exec).not.toHaveBeenCalled();
    const { getContractStats } = await import("./apply");
    expect(getContractStats().byKind["fallback-blocked"]).toBe(1);
  });

  it("erro do banco no SQL novo: reexecuta no legado COM aviso, exceto se o legado mudaria o resultado (ai sobe o erro)", async () => {
    const { runWithContract } = await fresh();
    let n = 0;
    const flaky = vi.fn(async (t: { sql: string }) => { if (n++ === 0) throw new PgError("function foo does not exist", "42883"); return { rows: [], sql: t.sql } as { rows: unknown[]; sql: string; warnings?: string[] }; });
    const r = await runWithContract("SELECT DATEADD(day, 1, d) FROM t", "postgres", "storage-pg", "regex", flaky);
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(r.warnings?.[0]).toMatch(/^LEGACY_TRANSLATION:.*erro do banco/);

    const blocked = vi.fn(async () => { throw new PgError("boom", "42883"); });
    await expect(runWithContract("SELECT DATEADD(month, 1, d) FROM t", "postgres", "storage-pg", "regex", blocked)).rejects.toMatchObject({ code: "42883" });
    expect(blocked).toHaveBeenCalledTimes(1);
  });

  it("strict continua rejeitando e shadow continua respondendo como antes (nada mudou)", async () => {
    state.mode = "strict";
    let m = await fresh();
    await expect(m.runWithContract("SELECT a::text FROM t", "postgres", "x", "regex", ok())).rejects.toMatchObject({ code: "UNSUPPORTED_CONSTRUCT" });
    state.mode = "shadow";
    m = await fresh();
    const exec = ok();
    const r = await m.runWithContract("SELECT a::text FROM t WHERE n LIKE 'x'", "postgres", "x", "regex", exec);
    expect(r.warnings).toBeUndefined();
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
