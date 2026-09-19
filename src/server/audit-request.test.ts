import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn() }));
vi.mock("@/server/db", () => ({ prisma: { auditEvent: { create: db.create, update: db.update } } }));

import { auditAuthFailure, auditRequestBegin, auditRequestFailed, auditRequestStart, clientIp, isAuditedWrite } from "./audit-request";

const req = (method: string, path: string, headers: Record<string, string> = {}) =>
  ({ method, nextUrl: { pathname: path }, headers: new Headers(headers) }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  db.create.mockResolvedValue({ id: "ev1" });
  db.update.mockResolvedValue({});
});

describe("isAuditedWrite", () => {
  it("escritas entram; leituras e POSTs que so consultam/testam ficam de fora", () => {
    expect(isAuditedWrite("POST", "/api/v1/tokens")).toBe(true);
    expect(isAuditedWrite("DELETE", "/api/v1/users/1/grants/2")).toBe(true);
    expect(isAuditedWrite("GET", "/api/v1/tokens")).toBe(false);
    expect(isAuditedWrite("POST", "/api/v1/queries")).toBe(false);
    expect(isAuditedWrite("POST", "/api/v1/queries/export")).toBe(false);
    expect(isAuditedWrite("POST", "/api/v1/dataset-sources/abc/query")).toBe(false);
    expect(isAuditedWrite("POST", "/api/v1/connections/test")).toBe(false);
  });
});

describe("clientIp", () => {
  it("usa o primeiro salto de x-forwarded-for", () => {
    expect(clientIp(req("GET", "/", { "x-forwarded-for": "1.2.3.4, 10.0.0.1" }))).toBe("1.2.3.4");
    expect(clientIp(req("GET", "/"))).toBeNull();
  });
});

describe("evento por requisicao", () => {
  it("grava API_WRITE sem corpo/query e marca falha", async () => {
    const store = auditRequestBegin();
    auditRequestStart(store, req("POST", "/api/v1/tokens"), { type: "token", id: "t1" });
    await store.eventId;
    expect(db.create.mock.calls[0][0].data).toMatchObject({ eventType: "API_WRITE", resourceId: "/api/v1/tokens", tokenId: "t1", success: true });
    auditRequestFailed(403, "FORBIDDEN");
    await new Promise((r) => setTimeout(r, 5));
    expect(db.update).toHaveBeenCalledWith({ where: { id: "ev1" }, data: { success: false, detailJson: JSON.stringify({ method: "", status: 403, code: "FORBIDDEN" }) } });
  });
  it("falha ao gravar auditoria nao derruba a requisicao", async () => {
    db.create.mockRejectedValue(new Error("db fora"));
    const store = auditRequestBegin();
    expect(() => auditRequestStart(store, req("DELETE", "/api/v1/tokens/1"), { type: "user", id: "u1" })).not.toThrow();
    await store.eventId;
  });
  it("GET nao gera evento", () => {
    const store = auditRequestBegin();
    auditRequestStart(store, req("GET", "/api/v1/tokens"), { type: "user", id: "u1" });
    expect(db.create).not.toHaveBeenCalled();
  });
  it("AUTH_FAILED e limitado a 1 por IP a cada 10s", () => {
    const r = req("POST", "/api/v1/tokens", { "x-forwarded-for": "9.9.9.9" });
    auditAuthFailure(r, "INVALID_TOKEN");
    auditAuthFailure(r, "INVALID_TOKEN");
    expect(db.create).toHaveBeenCalledTimes(1);
  });
});

import { auditJob, auditLogin, classifyRequest } from "./audit-request";

describe("cobertura do sistema inteiro", () => {
  it("classifica escrita, leitura de dados e leitura administrativa", () => {
    expect(classifyRequest("PATCH", "/api/v1/users/1")).toBe("API_WRITE");
    expect(classifyRequest("GET", "/api/odata/p/d/vendas")).toBe("DATA_READ");
    expect(classifyRequest("GET", "/api/v1/tables/abc/rows")).toBe("DATA_READ");
    expect(classifyRequest("POST", "/api/v1/queries/export")).toBe("DATA_READ");
    expect(classifyRequest("POST", "/api/v1/dataset-sources/abc/query")).toBe("DATA_READ");
    expect(classifyRequest("POST", "/api/v1/queries")).toBeNull(); // QUERY_EXECUTED ja cobre
    expect(classifyRequest("GET", "/api/v1/tokens")).toBe("ADMIN_READ");
    expect(classifyRequest("GET", "/api/v1/audit-events")).toBe("ADMIN_READ");
    expect(classifyRequest("GET", "/api/v1/projects")).toBeNull();
  });
  it("leitura de dados repetida pelo mesmo ator/rota: 1 evento por minuto", async () => {
    const store = auditRequestBegin();
    const r = req("GET", "/api/odata/p/d/vendas_x");
    auditRequestStart(store, r, { type: "token", id: "t9" });
    await store.eventId;
    auditRequestStart(store, r, { type: "token", id: "t9" });
    await store.eventId;
    expect(db.create).toHaveBeenCalledTimes(1);
    expect(db.create.mock.calls[0][0].data.eventType).toBe("DATA_READ");
  });
  it("403 em GET (sem evento de escrita) vira ACCESS_DENIED com o ator", async () => {
    const store = auditRequestBegin({ method: "GET", nextUrl: { pathname: "/api/v1/datasets/zz" }, headers: new Headers() } as never);
    auditRequestStart(store, req("GET", "/api/v1/datasets/zz"), { type: "user", id: "u7" });
    auditRequestFailed(403, "FORBIDDEN");
    await new Promise((r) => setTimeout(r, 5));
    expect(db.create.mock.calls.at(-1)![0].data).toMatchObject({ eventType: "ACCESS_DENIED", userId: "u7", success: false, resourceId: "/api/v1/datasets/zz" });
  });
  it("registra nomes dos campos alterados, nunca os valores", async () => {
    const store = auditRequestBegin();
    const r = { method: "PATCH", nextUrl: { pathname: "/api/v1/users/1" }, headers: new Headers({ "content-type": "application/json" }), clone: () => ({ json: async () => ({ role: "ADMIN", password: "segredo-123" }) }) } as never;
    auditRequestStart(store, r, { type: "user", id: "u1" });
    await store.eventId;
    const detail = db.create.mock.calls.at(-1)![0].data.detailJson as string;
    expect(JSON.parse(detail).fields).toEqual(["role", "password"]);
    expect(detail).not.toContain("segredo-123");
  });
  it("login: falha nao expoe senha e e limitada; sucesso e logout gravam", () => {
    auditLogin("LOGIN_SUCCESS", { userId: "u1", email: "a@b.c", ip: "1.1.1.1" });
    auditLogin("LOGIN_FAILED", { email: "x@y.z", ip: "2.2.2.2", reason: "bad_password" });
    auditLogin("LOGIN_FAILED", { email: "x@y.z", ip: "2.2.2.2", reason: "bad_password" });
    auditLogin("LOGOUT", { userId: "u1" });
    expect(db.create.mock.calls.map((c) => c[0].data.eventType)).toEqual(["LOGIN_SUCCESS", "LOGIN_FAILED", "LOGOUT"]);
    expect(JSON.stringify(db.create.mock.calls)).not.toMatch(/password"/);
  });
  it("job do worker: sucesso, falha com retry e erro truncado", async () => {
    await auditJob({ jobId: "j1", jobType: "SOURCE_REFRESH", success: true, workerLabel: "w-1", durationMs: 10, resourceType: "dataset_source", resourceId: "s1" });
    await auditJob({ jobId: "j2", jobType: "IMPORT_UPLOAD", success: false, workerLabel: "w-1", durationMs: 5, willRetry: true, error: "x".repeat(2000) });
    const [a, b] = db.create.mock.calls.map((c) => c[0].data);
    expect(a).toMatchObject({ eventType: "JOB_COMPLETED", resourceType: "dataset_source", resourceId: "s1", success: true });
    expect(b).toMatchObject({ eventType: "JOB_FAILED", success: false });
    expect(JSON.parse(b.detailJson as string).error.length).toBe(500);
  });
});
