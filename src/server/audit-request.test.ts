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
    expect(db.create.mock.calls[0][0].data).toMatchObject({ eventType: "API_WRITE", resourceId: "/api/v1/tokens", tokenId: "t1", success: true });
    auditRequestFailed(403, "FORBIDDEN");
    await new Promise((r) => setTimeout(r, 5));
    expect(db.update).toHaveBeenCalledWith({ where: { id: "ev1" }, data: { success: false, detailJson: JSON.stringify({ status: 403, code: "FORBIDDEN" }) } });
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
