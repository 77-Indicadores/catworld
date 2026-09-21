import { describe, expect, it } from "vitest";
import { canonicalAccepts, incompatibleColumns, incompatibleMessage, mssqlPhysicalToCanonical } from "./type-compat";

describe("canonicalAccepts: só alarga, nunca estreita", () => {
  it("iguais e texto aceitam", () => {
    expect(canonicalAccepts("BIGINT", "BIGINT")).toBe(true);
    expect(canonicalAccepts("NVARCHAR(MAX)", "DECIMAL(10,2)")).toBe(true);
    expect(canonicalAccepts("NVARCHAR(MAX)", "DATE")).toBe(true);
  });
  it("BIGINT não recebe decimal, texto, data (o caso 1,5 -> 2)", () => {
    expect(canonicalAccepts("BIGINT", "DECIMAL(18,4)")).toBe(false);
    expect(canonicalAccepts("BIGINT", "NVARCHAR(MAX)")).toBe(false);
    expect(canonicalAccepts("BIGINT", "DATE")).toBe(false);
  });
  it("DECIMAL recebe inteiro e decimal menor ou igual; recusa escala ou inteiros maiores", () => {
    expect(canonicalAccepts("DECIMAL(18,4)", "BIGINT")).toBe(true);
    expect(canonicalAccepts("DECIMAL(18,4)", "DECIMAL(10,2)")).toBe(true);
    expect(canonicalAccepts("DECIMAL(18,4)", "DECIMAL(18,4)")).toBe(true);
    expect(canonicalAccepts("DECIMAL(18,2)", "DECIMAL(18,4)")).toBe(false);   // escala maior arredondaria
    expect(canonicalAccepts("DECIMAL(10,2)", "DECIMAL(18,2)")).toBe(false);   // mais dígitos inteiros estouraria
    expect(canonicalAccepts("DECIMAL(18,4)", "NVARCHAR(MAX)")).toBe(false);
  });
  it("DATETIME2 recebe DATE, mas DATE não recebe DATETIME2 (a hora sumia)", () => {
    expect(canonicalAccepts("DATETIME2", "DATE")).toBe(true);
    expect(canonicalAccepts("DATE", "DATETIME2")).toBe(false);
    expect(canonicalAccepts("TIME", "DATETIME2")).toBe(false);
    expect(canonicalAccepts("DATE", "NVARCHAR(MAX)")).toBe(false);
  });
});

describe("incompatibleColumns", () => {
  const existing = [{ name: "id", sqlType: "BIGINT" }, { name: "valor", sqlType: "DECIMAL(18,4)" }, { name: "quando", sqlType: "DATETIME2" }];
  it("tudo compatível: vazio", () => {
    expect(incompatibleColumns(existing, [{ sqlName: "id", sqlType: "BIGINT" }, { sqlName: "valor", sqlType: "BIGINT" }, { sqlName: "quando", sqlType: "DATE" }])).toEqual([]);
  });
  it("lista cada coluna que estreitaria", () => {
    const r = incompatibleColumns(existing, [{ sqlName: "id", sqlType: "DECIMAL(18,4)" }, { sqlName: "valor", sqlType: "DECIMAL(18,4)" }, { sqlName: "quando", sqlType: "NVARCHAR(MAX)" }]);
    expect(r.map((c) => c.column)).toEqual(["id", "quando"]);
    expect(incompatibleMessage(r)).toContain('"id" é BIGINT e o arquivo traz DECIMAL(18,4)');
  });
});

describe("mssqlPhysicalToCanonical", () => {
  it("mapeia a família física", () => {
    expect(mssqlPhysicalToCanonical({ type_name: "int" })).toBe("BIGINT");
    expect(mssqlPhysicalToCanonical({ type_name: "decimal", precision: 12, scale: 3 })).toBe("DECIMAL(12,3)");
    expect(mssqlPhysicalToCanonical({ type_name: "datetime" })).toBe("DATETIME2");
    expect(mssqlPhysicalToCanonical({ type_name: "nvarchar" })).toBe("NVARCHAR(MAX)");
  });
});
