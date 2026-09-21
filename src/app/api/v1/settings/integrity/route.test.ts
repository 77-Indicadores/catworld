import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ settings: {} as Record<string, string>, role: "ADMIN", audited: [] as unknown[] }));
vi.mock("@/server/auth/actor", () => ({
  resolveActor: vi.fn(async () => ({ id: "u", role: m.role })),
  requireRole: vi.fn((a: { role: string }, roles: string[]) => { if (!roles.includes(a.role)) { const e = new Error("Forbidden") as Error & { status: number }; e.status = 403; throw e; } }),
}));
vi.mock("@/server/audit", () => ({ audit: vi.fn(async (...a: unknown[]) => { m.audited.push(a); }) }));
vi.mock("@/server/http", () => ({
  ok: (data: unknown) => Response.json({ data }),
  handleApiError: (e: unknown) => Response.json({ error: String((e as Error).message) }, { status: (e as { status?: number }).status ?? 400 }),
}));
vi.mock("@/server/db", () => ({
  prisma: {
    $executeRawUnsafe: vi.fn(async (_sql: string, key: string, value: string) => { m.settings[key] = value; return 1; }),
    $queryRawUnsafe: vi.fn(async () => Object.entries(m.settings).map(([key, value]) => ({ key, value }))),
  },
}));
import { GET, PATCH } from "./route";

const patch = (body: unknown) => PATCH(new Request("http://x", { method: "PATCH", body: JSON.stringify(body) }) as never);
beforeEach(() => { m.settings = {}; m.role = "ADMIN"; m.audited = []; });

describe("/api/v1/settings/integrity", () => {
  it("padrão: enforce, 30% e vazio não permitido", async () => {
    expect((await (await GET(new Request("http://x") as never)).json()).data).toEqual({ mode: "enforce", max_drop_pct: 30, allow_empty: false });
  });
  it("altera e devolve o estado novo; a mudança é auditada", async () => {
    const j = await (await patch({ mode: "warn", max_drop_pct: 50, allow_empty: true })).json();
    expect(j.data).toEqual({ mode: "warn", max_drop_pct: 50, allow_empty: true });
    expect(m.audited).toHaveLength(1);
  });
  it("valor fora da faixa é recusado e nada muda", async () => {
    expect((await patch({ max_drop_pct: 0 })).status).toBeGreaterThanOrEqual(400);
    expect((await patch({ mode: "off" })).status).toBeGreaterThanOrEqual(400);
    expect(m.settings).toEqual({});
  });
  it("só ADMIN", async () => {
    m.role = "READER";
    expect((await patch({ mode: "warn" })).status).toBe(403);
    expect(m.settings).toEqual({});
  });
});
