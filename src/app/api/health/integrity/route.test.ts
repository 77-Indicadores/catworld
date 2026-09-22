import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  summary: { windowHours: 24, loads: 10, failed: 0, suspect: 0, tablesNeedingAttention: [] as unknown[] },
  crashes: 0, queuedMin: null as number | null, auth: true, boom: false,
}));
vi.mock("@/server/auth/actor", () => ({ resolveActor: vi.fn(async () => { if (!m.auth) throw new Error("no"); return { id: "u" }; }) }));
vi.mock("@/server/integrity/ledger", () => ({ summarizeIntegrity: vi.fn(async () => { if (m.boom) throw new Error("db"); return m.summary; }) }));
vi.mock("@/server/db", () => ({
  prisma: {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => (String(strings[0]).includes("WORKER_CRASHED") ? [{ n: BigInt(m.crashes) }] : [{ minutes: m.queuedMin }])),
  },
}));

import { GET } from "./route";
const call = () => GET(new Request("http://x/api/health/integrity") as never);

beforeEach(() => { m.summary = { windowHours: 24, loads: 10, failed: 0, suspect: 0, tablesNeedingAttention: [] }; m.crashes = 0; m.queuedMin = null; m.auth = true; m.boom = false; });

describe("GET /api/health/integrity", () => {
  it("tudo bem: degraded=false, com detalhe para quem está logado", async () => {
    const j = await (await call()).json();
    expect(j.degraded).toBe(false);
    expect(j.integrity.loads).toBe(10);
    expect(j.workerCrashes1h).toBe(0);
  });
  it("sem login: só o estado, nenhum detalhe de tabela", async () => {
    m.auth = false; m.summary.tablesNeedingAttention = [{ tableName: "vendas_completo", verdict: "FAILED" }];
    const j = await (await call()).json();
    expect(j).toEqual({ degraded: true, time: expect.any(String) });
  });
  it("tabela com veredito pendente, 3+ quedas/h ou fila parada há mais de 30 min: degraded", async () => {
    m.summary.tablesNeedingAttention = [{ tableName: "t", verdict: "FAILED" }];
    expect((await (await call()).json()).degraded).toBe(true);
    m.summary.tablesNeedingAttention = []; m.crashes = 3;
    expect((await (await call()).json()).degraded).toBe(true);
    m.crashes = 2; m.queuedMin = 31;
    expect((await (await call()).json()).degraded).toBe(true);
    m.queuedMin = 10;
    expect((await (await call()).json()).degraded).toBe(false);
  });
  it("não conseguir avaliar é degradado (503), nunca 'tudo bem'", async () => {
    m.boom = true;
    const r = await call();
    expect(r.status).toBe(503);
    expect((await r.json()).degraded).toBe(true);
  });
});
