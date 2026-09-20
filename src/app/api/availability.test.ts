/**
 * Contrato de disponibilidade e previsibilidade: o que o cliente/orquestrador pode esperar quando algo falha,
 * fica lento ou e sobrecarregado — codigos e formatos estaveis, nada de vazar infraestrutura, degradacao controlada.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  checkSql: vi.fn(),
  resolveActor: vi.fn(),
  settings: vi.fn(),
}));

vi.mock("@/server/db", () => ({ prisma: { $queryRaw: mocks.queryRaw, $queryRawUnsafe: mocks.settings } }));
vi.mock("@/server/health/storage-probe", () => ({ probeStorage: mocks.checkSql }));
vi.mock("@/server/auth/actor", () => ({ resolveActor: mocks.resolveActor }));
vi.mock("@sentry/nextjs", () => ({ withScope: (fn: (s: unknown) => void) => fn({ setTag() {}, setContext() {} }), captureException() {}, flush: async () => true }));

import { GET as live } from "./health/live/route";
import { GET as ready } from "./health/ready/route";
import { GET as status } from "./health/status/route";
import { ApiError, handleApiError, isQueryTimeout, publicQueryErrorMessage } from "@/server/http";
import { acquireQuerySlot, checkRateLimit, releaseQuerySlot } from "@/server/query/protection";
import { getWorkerConfig, invalidateWorkerConfigCache } from "@/server/worker/config";

const DB_ERROR = new Error("getaddrinfo ENOTFOUND db-interno.prod.example:5432");

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.queryRaw.mockResolvedValue([{ "?column?": 1 }]);
  mocks.checkSql.mockResolvedValue({ latencyMs: 3, database: "x" });
  mocks.resolveActor.mockRejectedValue(new ApiError(401, "UNAUTHENTICATED", "x"));
});
afterEach(() => vi.restoreAllMocks());

describe("health", () => {
  it("live: 200 sem depender de nenhum banco", async () => {
    const res = live();
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });
  it("ready: 200 quando plano de controle e storage respondem", async () => {
    const res = await ready();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready" });
  });
  it("ready: 503 se o plano de controle cair — sem vazar host/erro no corpo", async () => {
    mocks.queryRaw.mockRejectedValue(DB_ERROR);
    const res = await ready();
    expect(res.status).toBe(503);
    const text = JSON.stringify(await res.json());
    expect(text).toBe('{"status":"not_ready"}');
    expect(text).not.toMatch(/db-interno|ENOTFOUND/);
  });
  it("ready: 503 se o storage cair", async () => {
    mocks.checkSql.mockRejectedValue(DB_ERROR);
    expect((await ready()).status).toBe(503);
  });
  it("status: anonimo so ve sql.ok (sem motivo da falha, host ou commit)", async () => {
    mocks.checkSql.mockRejectedValue(DB_ERROR);
    const res = await status({ headers: new Headers() } as never);
    const body = await res.json();
    expect(body.sql).toEqual({ ok: false });
    expect(JSON.stringify(body)).not.toMatch(/db-interno|ENOTFOUND|commit/);
  });
  it("status: nao gera auditoria de falha de autenticacao para sondas de monitoramento", async () => {
    await status({ headers: new Headers() } as never);
    expect(mocks.resolveActor).toHaveBeenCalledWith(expect.anything(), { audit: false });
  });
});

describe("erros previsiveis", () => {
  it("falha interna: 500 INTERNAL_ERROR generico + errorId, sem a mensagem original", async () => {
    const res = await handleApiError(DB_ERROR);
    expect(res.status).toBe(500);
    const { error } = await res.json();
    expect(error.code).toBe("INTERNAL_ERROR");
    expect(error.details.errorId).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(error)).not.toMatch(/db-interno|ENOTFOUND/);
  });
  it("erro de conexao do banco de storage nunca chega ao cliente", () => {
    expect(publicQueryErrorMessage("Failed to connect to postgres:1433 - getaddrinfo ENOTFOUND postgres")).toBe(
      "Falha ao conectar ao banco de dados. Tente novamente em instantes.",
    );
    expect(publicQueryErrorMessage('column "x" does not exist')).toBe('column "x" does not exist');
  });
  it("timeout de consulta e reconhecido (Postgres 57014 e SQL Server ETIMEOUT)", () => {
    expect(isQueryTimeout(Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }))).toBe(true);
    expect(isQueryTimeout(Object.assign(new Error("Timeout: Request failed to complete in 30000ms"), { code: "ETIMEOUT" }))).toBe(true);
    expect(isQueryTimeout(new Error("syntax error"))).toBe(false);
  });
  it("corpo invalido e erro do cliente (400), nao do servidor", async () => {
    const res = await handleApiError(new SyntaxError("Unexpected end of JSON input"));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_JSON");
  });
});

describe("sobrecarga previsivel (429 com Retry-After)", () => {
  it("semaforo de consultas: 429 no teto e recupera ao liberar", () => {
    let acquired = 0;
    try {
      for (let i = 0; i < 100; i++) { acquireQuerySlot(); acquired++; }
    } catch (e) {
      expect(e).toMatchObject({ status: 429, code: "TOO_MANY_CONCURRENT_QUERIES" });
    }
    expect(acquired).toBeGreaterThan(0);
    releaseQuerySlot();
    expect(() => acquireQuerySlot()).not.toThrow();
    for (let i = 0; i < acquired; i++) releaseQuerySlot();
  });
  it("rate limit: 429 RATE_LIMIT_EXCEEDED com Retry-After e libera depois da janela", async () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 60; i++) checkRateLimit("cw_t_avail", "query");
      let err: unknown;
      try { checkRateLimit("cw_t_avail", "query"); } catch (e) { err = e; }
      expect(err).toMatchObject({ status: 429, code: "RATE_LIMIT_EXCEEDED" });
      const res = await handleApiError(err);
      expect(res.status).toBe(429);
      expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
      vi.advanceTimersByTime(61_000);
      expect(() => checkRateLimit("cw_t_avail", "query")).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
  it("rate limit e por principal: um cliente no teto nao bloqueia outro", () => {
    for (let i = 0; i < 60; i++) checkRateLimit("cw_t_a", "upload");
    expect(() => checkRateLimit("cw_t_a", "upload")).toThrow();
    expect(() => checkRateLimit("cw_t_b", "upload")).not.toThrow();
  });
});

describe("degradacao controlada do worker", () => {
  beforeEach(() => {
    invalidateWorkerConfigCache();
    process.env.CATWORLD_DATABASE_URL = "postgres://x";
    process.env.CATWORLD_ENCRYPTION_KEY = "k";
    process.env.AUTH_SECRET = "s".repeat(32);
  });
  it("banco indisponivel: usa o env/defaults em vez de parar o worker", async () => {
    mocks.settings.mockRejectedValue(DB_ERROR);
    const cfg = await getWorkerConfig();
    expect(cfg).toEqual({ maxHeavyJobs: 2, maxSyncsPerStorage: 3, importBatchDelayMs: 200 });
  });
  it("valor corrompido no painel: ignora e usa o padrao (nunca NaN/0)", async () => {
    mocks.settings.mockResolvedValue([{ key: "worker.max_heavy_jobs", value: "abc" }, { key: "worker.max_syncs_per_storage", value: "0" }]);
    const cfg = await getWorkerConfig();
    expect(cfg.maxHeavyJobs).toBe(2);
    expect(cfg.maxSyncsPerStorage).toBe(3);
  });
});

describe("health/status autenticado", () => {
  it("falha do storage devolve codigo generico, nunca String(err)", async () => {
    mocks.resolveActor.mockResolvedValue({ type: "user" });
    mocks.checkSql.mockRejectedValue(DB_ERROR);
    const body = await (await status({ headers: new Headers() } as never)).json();
    expect(body.sql).toEqual({ ok: false, error: "STORAGE_UNAVAILABLE" });
    expect(JSON.stringify(body)).not.toMatch(/db-interno|ENOTFOUND/);
  });
});
