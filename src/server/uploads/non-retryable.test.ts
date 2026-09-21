import { describe, expect, it } from "vitest";
import { isNonRetryable } from "./non-retryable";
import { ValueConversionError } from "./convert-values";
import { TypeOverrideError } from "./parser";
import { IntegrityError } from "@/server/integrity/policy";
import { incompatibleError } from "./type-compat";

describe("erros deterministicos nao sao repetidos pelo worker", () => {
  it("ValueConversionError", () => {
    expect(isNonRetryable(new ValueConversionError({ sqlType: "INT" }, "x", "nao numerico"))).toBe(true);
  });
  it("TypeOverrideError", () => {
    expect(isNonRetryable(new TypeOverrideError("x"))).toBe(true);
  });
  it("IntegrityError", () => {
    const ev = { verdict: "FAILED", reasons: [] } as never;
    expect(isNonRetryable(new IntegrityError(ev))).toBe(true);
  });
  it("Tipos incompativeis", () => {
    expect(isNonRetryable(incompatibleError([{ column: "a", existing: "DATE", incoming: "TEXT" }]))).toBe(true);
  });
  it("erro comum continua repetivel", () => {
    expect(isNonRetryable(new Error("ECONNRESET"))).toBe(false);
    expect(isNonRetryable(null)).toBe(false);
  });
});
