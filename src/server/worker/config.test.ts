import { describe, expect, it } from "vitest";
import { pickInt } from "./config";

describe("pickInt (config do worker vinda do banco)", () => {
  it("aceita inteiro na faixa", () => {
    expect(pickInt("5", 2, 1, 20)).toBe(5);
    expect(pickInt("0", 200, 0, 5000)).toBe(0);
  });
  it("texto, NaN, vazio, decimal e fora da faixa caem no fallback", () => {
    for (const bad of ["abc", "NaN", "", " ", "1.5", "0", "-3", "99"]) expect(pickInt(bad, 2, 1, 20)).toBe(2);
    expect(pickInt(undefined, 2, 1, 20)).toBe(2);
  });
});
