import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  dataset: { id: "ds1", projectId: "p1" } as { id: string; projectId: string } | null,
  denied: false,
  findManyArgs: null as unknown,
}));

vi.mock("@/server/db", () => ({
  prisma: {
    dataset: { findUnique: async () => state.dataset },
    datasetTable: {
      findMany: async (args: unknown) => {
        state.findManyArgs = args;
        return [
          { id: "t1", name: "empresas", sqlName: "empresas", rowCount: 12345n, lastDataAt: new Date("2026-11-16T03:00:00Z"), source: null },
          {
            id: "t2", name: "vendas", sqlName: "vendas", rowCount: 9n, lastDataAt: null,
            source: { id: "s1", mode: "extract", active: true, lastStatus: "failed", lastRefreshedAt: null, nextRefreshAt: null, lastError: "Failed to connect to 10.0.0.5:1433 - getaddrinfo ENOTFOUND" },
          },
        ];
      },
    },
  },
}));
vi.mock("@/server/auth/actor", () => ({ resolveActor: async () => ({ type: "token", role: "VIEWER", principal: "t" }) }));
vi.mock("@/server/auth/permissions", async () => {
  const { ApiError } = await import("@/server/http");
  return { assertDatasetAccess: async () => { if (state.denied) throw new ApiError(403, "FORBIDDEN", "Sem acesso"); } };
});

const get = async () => {
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  const res = await GET(new NextRequest("http://localhost/api/v1/datasets/ds1/freshness"), { params: Promise.resolve({ id: "ds1" }) });
  return { status: res.status, body: await res.json() };
};

describe("GET /datasets/:id/freshness", { timeout: 60_000 }, () => {
  beforeEach(() => { state.dataset = { id: "ds1", projectId: "p1" }; state.denied = false; });

  it("so os campos de frescor: sem colunas nem conexao", async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body.data[0]).toEqual({ id: "t1", name: "empresas", sqlName: "empresas", rowCount: "12345", lastDataAt: "2026-11-16T03:00:00.000Z", source: null });
    const select = (state.findManyArgs as { select: Record<string, unknown> }).select;
    expect(Object.keys(select)).not.toContain("columns");
    expect(Object.keys(select.source as { select: object }).length).toBeGreaterThan(0);
    expect(JSON.stringify(select)).not.toContain("connection");
    expect(r.body.meta.serverTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("erro de conexao da fonte nao revela host/IP", async () => {
    const src = (await get()).body.data[1].source;
    expect(src.lastStatus).toBe("failed");
    expect(src.lastError).not.toContain("10.0.0.5");
  });

  it("sem acesso ao dataset: 403; dataset inexistente: lista vazia (como /tables)", async () => {
    state.denied = true;
    expect((await get()).status).toBe(403);
    state.denied = false;
    state.dataset = null;
    expect((await get()).body.data).toEqual([]);
  });
});
