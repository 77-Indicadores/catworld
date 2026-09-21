import { describe, expect, it } from "vitest";
import { edmFacets, nextPageParams, parseNonNegativeInt, parseSelect } from "./paging-facets";

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
    expect(nextPageParams({ top: 5000, wantedTop: 5000, topRequested: false, skip: 0, returned: 5000 })).toEqual({ top: null, skip: "5000" });
    expect(nextPageParams({ top: 5000, wantedTop: 5000, topRequested: false, skip: 5000, returned: 12 })).toBeNull();
  });
  it("$top=0: nunca ha nextLink", () => {
    expect(nextPageParams({ top: 0, wantedTop: 0, topRequested: true, skip: 0, returned: 0 })).toBeNull();
  });
});

/** Segue os nextLinks como o cliente (parse dos params do link) ate acabar; devolve linhas entregues e numero de paginas. */
function chain(totalRows: number, topParam: number | null): { delivered: number; pages: number } {
  let skip = 0, delivered = 0, pages = 0;
  let top: number | null = topParam;
  for (;;) {
    const topRequested = top !== null;
    const wantedTop = top ?? 5000;
    const eff = Math.min(wantedTop, 10_000);
    const returned = Math.max(0, Math.min(eff, totalRows - skip));
    delivered += returned; pages++;
    const np = nextPageParams({ top: eff, wantedTop, topRequested, skip, returned });
    if (!np) return { delivered, pages };
    top = np.top === null ? null : Number(np.top);
    skip = Number(np.skip);
    if (pages > 100) throw new Error("loop");
  }
}

describe("nextPageParams encadeado (segue os nextLinks ate acabar)", () => {
  it("sem $top: entrega a tabela inteira (23000 linhas)", () => {
    expect(chain(23_000, null).delivered).toBe(23_000);
    expect(chain(10_000, null).delivered).toBe(10_000);
    expect(chain(5_000, null).delivered).toBe(5_000);
    expect(chain(5_001, null).delivered).toBe(5_001);
  });
  it("$top explicito abaixo do tamanho de pagina", () => {
    expect(chain(23_000, 7)).toEqual({ delivered: 7, pages: 1 });
    expect(chain(3, 7).delivered).toBe(3);
  });
  it("$top acima de 10000: 25000 -> 15000 -> 5000 -> fim", () => {
    expect(chain(100_000, 25_000)).toEqual({ delivered: 25_000, pages: 3 });
    expect(chain(12_000, 25_000).delivered).toBe(12_000);
  });
  it("limites exatos", () => {
    expect(chain(100_000, 10_000)).toEqual({ delivered: 10_000, pages: 1 });
    expect(chain(100_000, 10_001)).toEqual({ delivered: 10_001, pages: 2 });
    expect(chain(100_000, 20_000)).toEqual({ delivered: 20_000, pages: 2 });
  });
});

describe("parseSelect", () => {
  it("_row_number e * sao validos", () => {
    expect(parseSelect("a,_row_number")).toEqual(["a"]);
    expect(parseSelect("*")).toBeNull();
    expect(parseSelect("a, *")).toBeNull();
    expect(parseSelect(null)).toBeNull();
    expect(parseSelect("a, b")).toEqual(["a", "b"]);
  });
});
