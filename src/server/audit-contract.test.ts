import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/server/db", () => ({ prisma: { auditEvent: { create: db.create } } }));

import { audit } from "./audit";
import { classifyRequest } from "./audit-request";
import { presentCount } from "@/lib/present";

beforeEach(() => { vi.clearAllMocks(); db.create.mockResolvedValue({ id: "e" }); });

describe("audit()", () => {
  it("nunca lanca quando a gravacao falha", async () => {
    db.create.mockRejectedValue(new Error("db fora"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(audit({ type: "user", id: "u1", role: "ADMIN", principal: "x" }, "X")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
  it("grava ator e ipAddress (null fora de requisicao)", async () => {
    await audit({ type: "token", id: "t1", role: "ADMIN", principal: "x" }, "PROJECT_CREATED", "project", "p", { method: "POST", fields: ["name"] });
    expect(db.create.mock.calls[0][0].data).toMatchObject({ tokenId: "t1", userId: null, ipAddress: null, success: true });
  });
});

describe("classifyRequest", () => {
  it("exportacao e historico de tabela sao DATA_READ", () => {
    expect(classifyRequest("GET", "/api/v1/tables/abc/export")).toBe("DATA_READ");
    expect(classifyRequest("GET", "/api/v1/tables/abc/history")).toBe("DATA_READ");
  });
});

describe("presentCount rollover", () => {
  it("999.950..999.999 vira 1 mi; 999.949 continua mil", () => {
    expect(presentCount(999_950)!.compact).toBe("1 mi");
    expect(presentCount(999_999)!.compact).toBe("1 mi");
    expect(presentCount(999_949)!.compact).toBe("999,9 mil");
    expect(presentCount(999_950_000)!.compact).toBe("1 bi");
  });
});
