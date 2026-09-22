// @vitest-environment node
/** TIP-12 (nomes reservados) e TIP-16 (colisão e limite de 63 bytes do Postgres). */
import { describe, expect, it } from "vitest";
import { sqlIdentifier, fitIdentifiers, uniqueIdentifier } from "./naming";

describe("TIP-12: nomes reservados", () => {
  it("cw_deleted_at, cw_synced_at e _cw_rh do usuário viram nomes seguros e determinísticos", () => {
    expect(sqlIdentifier("cw_deleted_at")).toBe("cw_deleted_at_col");
    expect(sqlIdentifier("CW_Synced_At")).toBe("cw_synced_at_col");
    expect(sqlIdentifier("_cw_rh")).toBe("cw_rh_col");
    expect(sqlIdentifier("cw_deleted_at")).toBe(sqlIdentifier("cw_deleted_at"));
  });
  it("nomes parecidos não são afetados", () => {
    expect(sqlIdentifier("cw_deleted_at_2")).toBe("cw_deleted_at_2");
    expect(sqlIdentifier("Valor Total")).toBe("valor_total");
  });
});

describe("TIP-16: colisões e limite", () => {
  it("uniqueIdentifier repete até achar nome livre (a, a, a_2, a -> a, a_2, a_2_2, a_3)", () => {
    const taken = new Set<string>();
    expect(["a", "a", "a_2", "a"].map((n) => uniqueIdentifier(n, taken))).toEqual(["a", "a_2", "a_2_2", "a_3"]);
    expect(taken.size).toBe(4);
  });
  it("fitIdentifiers: nomes curtos e únicos ficam intactos", () => {
    expect(fitIdentifiers(["id", "nome", "valor"])).toEqual(["id", "nome", "valor"]);
  });
  it("fitIdentifiers: nomes longos com o mesmo prefixo de 63 bytes continuam distintos e <= 63", () => {
    const base = "x".repeat(70);
    const out = fitIdentifiers([base + "_a", base + "_b", "y"]);
    expect(out.every((n) => Buffer.byteLength(n) <= 63)).toBe(true);
    expect(new Set(out).size).toBe(3);
    expect(out[2]).toBe("y");
    expect(fitIdentifiers([base + "_a", base + "_b", "y"])).toEqual(out);
  });
  it("fitIdentifiers: nome encurtado que colide com nome existente ganha sufixo", () => {
    const long = "c".repeat(80);
    const short = fitIdentifiers([long])[0]!;
    const out = fitIdentifiers([short, long]);
    expect(new Set(out).size).toBe(2);
    expect(out.every((n) => n.length <= 63)).toBe(true);
  });
});
