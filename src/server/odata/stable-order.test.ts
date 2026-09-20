import { describe, expect, it } from "vitest";
import { stableOrderBy } from "./stable-order";

const q = (n: string) => `"${n}"`;
describe("stableOrderBy", () => {
  it("ordena por todas as colunas comparaveis", () => {
    expect(stableOrderBy([{ name: "a", sqlType: "INT" }, { name: "b", sqlType: "NVARCHAR(MAX)" }], q)).toBe('"a", "b"');
  });
  it("exclui tipos sem ordenacao", () => {
    expect(stableOrderBy([{ name: "a", sqlType: "XML" }, { name: "b", sqlType: "text" }, { name: "c", sqlType: "INT" }], q)).toBe('"c"');
  });
  it("sem colunas ordenaveis: null", () => {
    expect(stableOrderBy([{ name: "a", sqlType: "IMAGE" }], q)).toBeNull();
  });
  it("ctid no Postgres", () => {
    expect(stableOrderBy([{ name: "a" }], q, { useCtid: true })).toBe("ctid");
  });
});
