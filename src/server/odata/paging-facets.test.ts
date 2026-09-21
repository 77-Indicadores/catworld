import { describe, expect, it } from "vitest";
import { edmFacets, nextPageParams, parseNonNegativeInt } from "./paging-facets";

describe("edmFacets", () => {
  it("decimal com precisao e escala; sem parametros = Scale variavel", () => {
    expect(edmFacets("DECIMAL(18,4)")).toBe(' Precision="18" Scale="4"');
    expect(edmFacets("NUMERIC(10)")).toBe(' Precision="10" Scale="0"');
    expect(edmFacets("DECIMAL")).toBe(' Scale="variable"');
    expect(edmFacets("MONEY")).toBe(' Precision="19" Scale="4"');
  });
  it("timestamps com microssegundos; texto e inteiros sem faceta", () => {
    expect(edmFacets("DATETIME2")).toBe(' Precision="6"');
    expect(edmFacets("DATETIME")).toBe(' Precision="3"');
    expect(edmFacets("NVARCHAR(MAX)")).toBe("");
    expect(edmFacets("BIGINT")).toBe("");
  });
});

describe("$top / $skip", () => {
  it("valida inteiro >= 0", () => {
    expect(parseNonNegativeInt(null, "$top", 5000)).toBe(5000);
    expect(parseNonNegativeInt("0", "$top", 5000)).toBe(0);
    for (const bad of ["abc", "-1", "1.5", "1e3"]) expect(() => parseNonNegativeInt(bad, "$top", 1), bad).toThrow(/inteiro/);
  });
  it("$top explicito e respeitado: 5 linhas pedidas, 5 entregues, SEM nextLink (antes gerava nextLink e o cliente lia mais)", () => {
    expect(nextPageParams({ top: 5, wantedTop: 5, topRequested: true, skip: 0, returned: 5 })).toBeNull();
  });
  it("$top acima do teto: pagina de 10000 e o nextLink carrega o RESTANTE", () => {
    expect(nextPageParams({ top: 10_000, wantedTop: 25_000, topRequested: true, skip: 0, returned: 10_000 })).toEqual({ top: "15000", skip: "10000" });
    expect(nextPageParams({ top: 10_000, wantedTop: 15_000, topRequested: true, skip: 10_000, returned: 10_000 })).toEqual({ top: "5000", skip: "20000" });
    // a ultima pagina (top = 10000 = restante): nada mais
    expect(nextPageParams({ top: 10_000, wantedTop: 10_000, topRequested: true, skip: 10_000, returned: 10_000 })).toBeNull();
  });
  it("sem $top: paginacao do servidor enquanto a pagina vier cheia", () => {
    expect(nextPageParams({ top: 5000, wantedTop: 5000, topRequested: false, skip: 0, returned: 5000 })).toEqual({ top: "5000", skip: "5000" });
    expect(nextPageParams({ top: 5000, wantedTop: 5000, topRequested: false, skip: 5000, returned: 12 })).toBeNull();
  });
  it("$top=0: nunca ha nextLink", () => {
    expect(nextPageParams({ top: 0, wantedTop: 0, topRequested: true, skip: 0, returned: 0 })).toBeNull();
  });
});
