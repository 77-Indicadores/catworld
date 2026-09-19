import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db", () => ({ prisma: {} }));
vi.mock("@/server/db/advisory-lock", () => ({ withAdvisoryLock: vi.fn() }));
vi.mock("@/server/azure/sql", () => ({ sqlPool: vi.fn(), ensureSchema: vi.fn() }));
vi.mock("@/server/storage/connection", () => ({ getStorageConnection: vi.fn() }));

import { assertValidCron } from "./sources";
import { handleApiError } from "@/server/http";

describe("assertValidCron", () => {
  it("vazio/null/valido passam", () => {
    for (const ok of [null, undefined, "", "  ", "0 * * * *", "*/15 * * * *"]) expect(() => assertValidCron(ok)).not.toThrow();
  });
  it("invalido: 400 INVALID_CRON", () => {
    expect(() => assertValidCron("banana", "refreshCron")).toThrowError(expect.objectContaining({ status: 400, code: "INVALID_CRON" }));
    expect(() => assertValidCron("99 * * * *")).toThrow();
  });
});

describe("handleApiError P2002", () => {
  it("unicidade do Prisma vira 409 CONFLICT", async () => {
    const res = await handleApiError({ code: "P2002", meta: { target: ["target_table_id"] } });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CONFLICT");
  });
});
