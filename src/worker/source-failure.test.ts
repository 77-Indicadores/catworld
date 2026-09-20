import { describe, expect, it } from "vitest";
import { ApiError } from "@/server/http";
import { isSourceBusyError } from "./source-failure";

describe("isSourceBusyError", () => {
  it("reconhece o 409 da trava mútua da fonte", () => {
    expect(isSourceBusyError(new ApiError(409, "SOURCE_REFRESH_IN_PROGRESS", "x"))).toBe(true);
  });
  it("não confunde outras falhas (nem valores estranhos)", () => {
    expect(isSourceBusyError(new ApiError(409, "SOURCE_ALREADY_EXISTS", "x"))).toBe(false);
    expect(isSourceBusyError(new Error("timeout"))).toBe(false);
    expect(isSourceBusyError(null)).toBe(false);
    expect(isSourceBusyError("SOURCE_REFRESH_IN_PROGRESS")).toBe(false);
  });
});
