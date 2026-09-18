import { beforeEach, describe, expect, it, vi } from "vitest";

const state = { mode: undefined as string | undefined };
vi.mock("@/server/db", () => ({
  prisma: { $queryRawUnsafe: vi.fn(async () => (state.mode ? [{ value: state.mode }] : [])) },
}));

import { contractTranslate } from "./apply";

// TtlCache de 30s guarda o modo; cada teste usa um modulo novo
async function fresh() {
  vi.resetModules();
  return (await import("./apply")).contractTranslate;
}

describe("contractTranslate por modo", () => {
  beforeEach(() => { state.mode = undefined; vi.spyOn(console, "warn").mockImplementation(() => {}); });

  it("mssql nunca e tocado", async () => {
    expect((await contractTranslate("SELECT TOP 5 * FROM t", "mssql", "x", "regex")).sql).toBe("SELECT TOP 5 * FROM t");
  });

  it("sem configuracao = shadow: responde como antes (live = passthrough) e loga o que o motor novo rejeitaria", async () => {
    const run = await fresh();
    const r = await run("SELECT a::text FROM t", "postgres", "live-pg", "passthrough");
    expect(r.sql).toBe("SELECT a::text FROM t");
    const logged = (console.warn as unknown as { mock: { calls: string[][] } }).mock.calls.map((c) => JSON.parse(c[0]!));
    expect(logged[0]).toMatchObject({ tag: "sql-contract", kind: "shadow-reject", path: "live-pg" });
  });

  it("shadow no storage PG: resposta e a do regex antigo", async () => {
    const run = await fresh();
    const r = await run("SELECT TOP 3 ISNULL(a,0) FROM t", "postgres", "storage-pg", "regex");
    expect(r.topLimit).toBe(3);
    expect(r.sql).toContain("COALESCE(");
  });

  it("log nao carrega literais", async () => {
    const run = await fresh();
    await run("SELECT a::text FROM t WHERE c = 'segredo-123'", "postgres", "live-pg", "passthrough");
    const line = (console.warn as unknown as { mock: { calls: string[][] } }).mock.calls[0]![0]!;
    expect(line).not.toContain("segredo-123");
  });

  it("strict rejeita '::' e construcoes fora do contrato", async () => {
    state.mode = "strict";
    const run = await fresh();
    await expect(run("SELECT a::text FROM t", "postgres", "live-pg", "passthrough")).rejects.toMatchObject({ code: "UNSUPPORTED_CONSTRUCT" });
    await expect(run("SELECT * FROM t WHERE a ILIKE 'x'", "postgres", "live-pg", "passthrough")).rejects.toMatchObject({ code: "UNSUPPORTED_CONSTRUCT" });
  });

  it("off: comportamento antigo, sem log", async () => {
    state.mode = "off";
    const run = await fresh();
    const r = await run("SELECT a::text FROM t", "postgres", "live-pg", "passthrough");
    expect(r.sql).toBe("SELECT a::text FROM t");
    expect((console.warn as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
  });
});
