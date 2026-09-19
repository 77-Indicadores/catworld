import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClientError, apiRequest, errorMessage, friendlyMessage, toApiClientError, warningsOf } from "./api-client";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

afterEach(() => vi.unstubAllGlobals());

describe("mensagens de erro em portugues", () => {
  it("traduz os codigos do contrato", () => {
    expect(friendlyMessage("CONNECTION_FORBIDDEN", "x")).toMatch(/conexão/i);
    expect(friendlyMessage("SCHEMA_FORBIDDEN", "x")).toMatch(/dataset/i);
    expect(friendlyMessage("INVALID_CRON", "x")).toMatch(/0 3 \* \* \*/);
    expect(friendlyMessage("CONFLICT", "x")).toMatch(/Já existe/);
  });
  it("429 mostra quando tentar de novo; 500 mostra o codigo de suporte", () => {
    expect(friendlyMessage("RATE_LIMIT_EXCEEDED", undefined, { retryAfterSeconds: 12 })).toContain("12s");
    expect(friendlyMessage("INTERNAL_ERROR", undefined, { errorId: "ab12cd34" })).toContain("ab12cd34");
  });
  it("codigo desconhecido cai na mensagem do servidor, depois num texto padrao", () => {
    expect(friendlyMessage("NOVO_CODIGO", "detalhe do servidor")).toBe("detalhe do servidor");
    expect(friendlyMessage("NOVO_CODIGO", undefined)).toMatch(/Não foi possível/);
  });
  it("validacao lista os campos com problema", () => {
    const e = toApiClientError(400, { error: { code: "VALIDATION_ERROR", message: "x", details: { issues: [{ path: "name", message: "obrigatório" }] } } });
    expect(e.message).toContain("name");
    expect(e.code).toBe("VALIDATION_ERROR");
  });
  it("sem envelope: infere pelo status e le Retry-After do cabecalho", () => {
    expect(toApiClientError(403, null).code).toBe("FORBIDDEN");
    expect(toApiClientError(500, null).code).toBe("INTERNAL_ERROR");
    expect(toApiClientError(429, null, "30").retryAfterSeconds).toBe(30);
  });
});

describe("apiRequest", () => {
  it("desembrulha data e meta", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { data: { a: 1 }, meta: { warnings: ["w1"] }, error: null })));
    const r = await apiRequest<{ a: number }>("/x");
    expect(r.data.a).toBe(1);
    expect(warningsOf(r.meta)).toEqual(["w1"]);
  });
  it("falha HTTP lanca ApiClientError com codigo, status e errorId", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(500, { data: null, error: { code: "INTERNAL_ERROR", message: "x", details: { errorId: "deadbeef" } } })));
    await expect(apiRequest("/x")).rejects.toMatchObject({ status: 500, code: "INTERNAL_ERROR", errorId: "deadbeef" });
  });
  it("rede fora do ar vira NETWORK, nunca erro solto", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const err = await apiRequest("/x").catch((e) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect(err.code).toBe("NETWORK");
    expect(errorMessage(err)).toMatch(/conexão/i);
  });
  it("corpo nao-JSON em erro nao quebra", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502 })));
    await expect(apiRequest("/x")).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });
});

import { apiErrorText } from "./api-client";
describe("apiErrorText (telas com fetch direto)", () => {
  it("usa a dica em portugues do codigo, o texto do servidor ou o fallback", () => {
    expect(apiErrorText({ error: { code: "INVALID_CRON", message: "Expressao cron invalida" } }, "Falha")).toMatch(/0 3/);
    expect(apiErrorText({ error: { code: "OUTRO", message: "texto do servidor" } }, "Falha")).toBe("texto do servidor");
    expect(apiErrorText({}, "Falha ao salvar")).toBe("Falha ao salvar");
    expect(apiErrorText(null, "Falha ao salvar")).toBe("Falha ao salvar");
  });
});
