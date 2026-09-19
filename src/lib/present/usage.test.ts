import { describe, expect, it } from "vitest";
import { normalizeOrigin, odataTableUrl, qualifiedSqlName, rowsUrl, sdkChangesExample, sinceCurlExample, sqlSelectExample, supportsSince } from "./usage";

describe("consumo da tabela", () => {
  it("nome SQL com schema e exemplo de SELECT", () => {
    expect(qualifiedSqlName("ds_test", "vendas")).toBe("ds_test.vendas");
    expect(sqlSelectExample("ds_test", "vendas")).toBe("SELECT TOP 100 * FROM ds_test.vendas");
  });
  it("URL OData por tabela (projeto/dataset/tabela) e sem barra dupla", () => {
    expect(odataTableUrl("https://x.com/", "teste", "ds", "vendas")).toBe("https://x.com/api/odata/teste/ds/vendas");
    expect(rowsUrl("https://x.com", "t1")).toBe("https://x.com/api/v1/tables/t1/rows");
  });
  it("origem ausente vira um marcador visível, nunca 'undefined'", () => {
    expect(normalizeOrigin("")).toBe("https://SEU-CATWORLD");
    expect(normalizeOrigin(undefined)).toBe("https://SEU-CATWORLD");
    expect(odataTableUrl("", "p", "d", "t")).toContain("https://SEU-CATWORLD/api/odata/p/d/t");
  });
  it("since só para fonte extract", () => {
    expect(supportsSince({ mode: "extract" })).toBe(true);
    expect(supportsSince({ mode: "live" })).toBe(false);
    expect(supportsSince(null)).toBe(false);
  });
  it("exemplos usam o id da tabela e o protocolo nextSince", () => {
    const curl = sinceCurlExample("https://x.com", "t1");
    expect(curl).toContain("since=<meta.nextSince>");
    expect(curl).toContain("/api/v1/tables/t1/rows");
    expect(sdkChangesExample("t1")).toContain('client.changes("t1"');
    expect(sdkChangesExample("t1")).toContain("nextSince");
  });
});
