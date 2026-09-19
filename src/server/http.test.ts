import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const sentry = vi.hoisted(() => ({
  captureException: vi.fn(),
  flush: vi.fn(() => new Promise<boolean>(() => {})), // nunca resolve: a resposta NAO pode esperar por ele
  withScope: vi.fn((fn: (s: { setTag: () => void; setContext: () => void }) => void) => fn({ setTag: () => {}, setContext: () => {} })),
}));
vi.mock("@sentry/nextjs", () => sentry);

import { ApiError, handleApiError, publicQueryErrorMessage } from "./http";

const body = async (r: Response) => (await r.json()) as { data: unknown; meta: unknown; error: { code: string; message: string; details: any } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("handleApiError", () => {
  it("ApiError mantem status, codigo e detalhes", async () => {
    const r = await handleApiError(new ApiError(409, "SOURCE_REFRESH_IN_PROGRESS", "em andamento", { a: 1 }));
    expect(r.status).toBe(409);
    expect((await body(r)).error).toEqual({ code: "SOURCE_REFRESH_IN_PROGRESS", message: "em andamento", details: { a: 1 } });
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("429 devolve o cabecalho Retry-After", async () => {
    const r = await handleApiError(new ApiError(429, "RATE_LIMIT_EXCEEDED", "limite", { retryAfterSeconds: 17 }));
    expect(r.status).toBe(429);
    expect(r.headers.get("Retry-After")).toBe("17");
  });

  it("entrada invalida (zod) e 400 VALIDATION_ERROR com o campo, e NAO vai para o Sentry", async () => {
    const parsed = z.object({ limit: z.number(), sql: z.string().min(1) }).safeParse({ limit: "abc", sql: "" });
    if (parsed.success) throw new Error("esperava falhar");
    const r = await handleApiError(parsed.error);
    expect(r.status).toBe(400);
    const b = await body(r);
    expect(b.error.code).toBe("VALIDATION_ERROR");
    expect(b.error.details.issues.map((i: { path: string }) => i.path).sort()).toEqual(["limit", "sql"]);
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("JSON malformado e 400 INVALID_JSON", async () => {
    let err: unknown;
    try { JSON.parse("{oops"); } catch (e) { err = e; }
    const r = await handleApiError(err);
    expect(r.status).toBe(400);
    expect((await body(r)).error.code).toBe("INVALID_JSON");
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("erro interno: mensagem generica (sem vazar host), errorId, Sentry e log com o detalhe", async () => {
    const secret = new Error("connect ECONNREFUSED db-interno.corp:1433 (usuario sa)");
    const r = await handleApiError(secret);
    expect(r.status).toBe(500);
    const b = await body(r);
    expect(b.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(b)).not.toContain("db-interno");
    expect(b.error.details.errorId).toMatch(/^[0-9a-f]{8}$/);
    expect(sentry.captureException).toHaveBeenCalledWith(secret);
    expect(console.error).toHaveBeenCalled();
  });

  it("nao espera o Sentry.flush (que aqui nunca resolve)", async () => {
    const r = await Promise.race([
      handleApiError(new Error("x")),
      new Promise<"travou">((res) => setTimeout(() => res("travou"), 500)),
    ]);
    expect(r).not.toBe("travou");
  });
});

describe("publicQueryErrorMessage", () => {
  it("esconde erro de conexao", () => {
    for (const m of [
      "Cannot open server '77indicadores' requested by the login. Client with IP address '1.2.3.4' is not allowed to access the server.",
      "getaddrinfo ENOTFOUND postgres",
      "Failed to connect to postgres:1433 - connect ECONNREFUSED",
      "Connection lost - socket hang up",
    ]) {
      expect(publicQueryErrorMessage(m)).toBe("Falha ao conectar ao banco de dados. Tente novamente em instantes.");
    }
  });

  it("mantem erro do SQL do usuario", () => {
    expect(publicQueryErrorMessage('column "id" does not exist')).toBe('column "id" does not exist');
    expect(publicQueryErrorMessage("Incorrect syntax near 'LIMIT'.")).toBe("Incorrect syntax near 'LIMIT'.");
  });
});
