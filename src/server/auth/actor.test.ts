import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: null as { user: { id: string; role: string } } | null,
  user: vi.fn(),
  tokenFind: vi.fn(),
  tokenUpdate: vi.fn(async () => ({})),
}));

vi.mock("@/auth", () => ({ auth: async () => mocks.session }));
vi.mock("@/server/db", () => ({
  prisma: { user: { findUnique: mocks.user }, apiToken: { findUnique: mocks.tokenFind, update: mocks.tokenUpdate } },
}));

import { invalidateActorCache, requireRole, resolveActor } from "./actor";

const req = (authorization?: string) => ({ headers: { get: (k: string) => (k.toLowerCase() === "authorization" ? authorization ?? null : null) } }) as never;
let uid = 0;
const newUser = () => `user-${++uid}-aaaaaaaaaaaaaaaaaaaa`;

beforeEach(() => {
  vi.clearAllMocks();
  invalidateActorCache();
  mocks.session = null;
});

describe("resolveActor — usuario (sessao JWT)", () => {
  it("usa o PAPEL do banco, nao o do JWT (mudanca de papel vale sem novo login)", async () => {
    const id = newUser();
    mocks.session = { user: { id, role: "ADMIN" } }; // JWT antigo diz ADMIN
    mocks.user.mockResolvedValue({ active: true, role: "VIEWER" }); // banco: rebaixado
    const actor = await resolveActor();
    expect(actor.role).toBe("VIEWER");
    expect(() => requireRole(actor, ["ADMIN"])).toThrow();
  });

  it("usuario desativado: 401, mesmo com JWT valido", async () => {
    const id = newUser();
    mocks.session = { user: { id, role: "ADMIN" } };
    mocks.user.mockResolvedValue({ active: false, role: "ADMIN" });
    await expect(resolveActor()).rejects.toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
  });

  it("usuario removido do banco: 401", async () => {
    mocks.session = { user: { id: newUser(), role: "ADMIN" } };
    mocks.user.mockResolvedValue(null);
    await expect(resolveActor()).rejects.toMatchObject({ status: 401 });
  });

  it("sem sessao: 401", async () => {
    await expect(resolveActor()).rejects.toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
  });

  it("consulta o usuario 1 vez (cache) e de novo depois de invalidar", async () => {
    const id = newUser();
    mocks.session = { user: { id, role: "ADMIN" } };
    mocks.user.mockResolvedValue({ active: true, role: "ADMIN" });
    await resolveActor();
    await resolveActor();
    expect(mocks.user).toHaveBeenCalledTimes(1);
    invalidateActorCache(id); // o que PATCH /users/:id faz
    mocks.user.mockResolvedValue({ active: false, role: "ADMIN" });
    await expect(resolveActor()).rejects.toMatchObject({ status: 401 });
    expect(mocks.user).toHaveBeenCalledTimes(2);
  });
});

describe("resolveActor — token", () => {
  const token = (lastUsedAt: Date | null) => ({ id: "11111111-1111-4111-8111-111111111111", active: true, expiresAt: null, lastUsedAt });

  it("token valido; lastUsedAt so e gravado se passou mais de 1 min", async () => {
    mocks.tokenFind.mockResolvedValue(token(new Date()));
    await resolveActor(req("Bearer cw_live_x"));
    expect(mocks.tokenUpdate).not.toHaveBeenCalled();

    mocks.tokenFind.mockResolvedValue(token(new Date(Date.now() - 5 * 60_000)));
    await resolveActor(req("Bearer cw_live_x"));
    expect(mocks.tokenUpdate).toHaveBeenCalledTimes(1);

    mocks.tokenFind.mockResolvedValue(token(null));
    await resolveActor(req("Bearer cw_live_x"));
    expect(mocks.tokenUpdate).toHaveBeenCalledTimes(2);
  });

  it("token revogado, expirado ou inexistente: 401 INVALID_TOKEN", async () => {
    mocks.tokenFind.mockResolvedValue({ ...token(null), active: false });
    await expect(resolveActor(req("Bearer x"))).rejects.toMatchObject({ status: 401, code: "INVALID_TOKEN" });
    mocks.tokenFind.mockResolvedValue({ ...token(null), expiresAt: new Date(Date.now() - 1000) });
    await expect(resolveActor(req("Bearer x"))).rejects.toMatchObject({ code: "INVALID_TOKEN" });
    mocks.tokenFind.mockResolvedValue(null);
    await expect(resolveActor(req("Bearer x"))).rejects.toMatchObject({ code: "INVALID_TOKEN" });
  });
});

describe("resolveActor — limite de requisicoes", () => {
  it("429 depois do teto por principal; rateLimit:false (OData) nao conta", async () => {
    mocks.tokenFind.mockResolvedValue({ id: "22222222-2222-4222-8222-222222222222", active: true, expiresAt: null, lastUsedAt: new Date() });
    let ok = 0;
    let err: unknown;
    for (let i = 0; i < 2500 && !err; i++) {
      try { await resolveActor(req("Bearer x")); ok++; } catch (e) { err = e; }
    }
    expect(ok).toBe(2400);
    expect(err).toMatchObject({ status: 429, code: "RATE_LIMIT_EXCEEDED", details: { retryAfterSeconds: expect.any(Number) } });
    await expect(resolveActor(req("Bearer x"), { rateLimit: false })).resolves.toMatchObject({ type: "token" });
  });

  it("chamada sem request (renderizacao de pagina) nao conta", async () => {
    const id = newUser();
    mocks.session = { user: { id, role: "ADMIN" } };
    mocks.user.mockResolvedValue({ active: true, role: "ADMIN" });
    for (let i = 0; i < 3000; i++) await resolveActor();
  });
});
