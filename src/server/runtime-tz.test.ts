import { afterEach, describe, expect, it } from "vitest";
import { ensureUtcTimezone } from "./runtime-tz";

const original = process.env.TZ;
afterEach(() => { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; });

describe("ensureUtcTimezone", () => {
  it("define TZ=UTC quando estava diferente e devolve o valor anterior", () => {
    process.env.TZ = "Asia/Tokyo";
    expect(ensureUtcTimezone()).toBe("Asia/Tokyo");
    expect(process.env.TZ).toBe("UTC");
    expect(new Date(2026, 0, 1, 0, 0, 0).toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
  it("define quando ausente", () => {
    delete process.env.TZ;
    expect(ensureUtcTimezone()).toBeUndefined();
    expect(process.env.TZ).toBe("UTC");
  });
  it("e idempotente", () => {
    process.env.TZ = "UTC";
    expect(ensureUtcTimezone()).toBe("UTC");
    expect(process.env.TZ).toBe("UTC");
  });
});
