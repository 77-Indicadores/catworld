import { describe, expect, it } from "vitest";
import { convert } from "./importer";

describe("convert() não corrompe decimais (regressão)", () => {
  it("preserva valor decimal em formato internacional (ponto como separador decimal)", () => {
    expect(convert("123.45", "DECIMAL(18,4)")).toBe(123.45);
  });
  it("converte decimal em formato brasileiro (ponto de milhar, vírgula decimal)", () => {
    expect(convert("1.234,56", "DECIMAL(18,4)")).toBe(1234.56);
    expect(convert("123,45", "DECIMAL(18,4)")).toBe(123.45);
  });

  it("trata campo só com espaço em branco como nulo, igual a inferência de schema", () => {
    expect(convert(" ", "BIGINT")).toBeNull();
    expect(convert(" ", "DATE")).toBeNull();
    expect(convert("", "DECIMAL(18,4)")).toBeNull();
  });

  it("converte datas DD/MM/YYYY e ISO corretamente", () => {
    expect(convert("04/05/2026", "DATE")).toEqual(new Date("2026-05-04T00:00:00Z"));
    expect(convert("2026-05-04", "DATE")).toEqual(new Date("2026-05-04"));
  });

  it("mantém BIGINT como string", () => {
    expect(convert(123, "BIGINT")).toBe("123");
  });

  it("converte DATETIME2 em formato BR com hora", () => {
    expect(convert("12/02/2024 12:30:01", "DATETIME2")).toEqual(new Date("2024-02-12T12:30:01"));
    expect(convert("2024-02-12T12:30:01", "DATETIME2")).toEqual(new Date("2024-02-12T12:30:01"));
  });

  it("converte DATETIME2 em formato BR sem segundos", () => {
    expect(convert("15/01/2026 08:30", "DATETIME2")).toEqual(new Date("2026-01-15T08:30"));
  });

  it("mantém TIME como string", () => {
    expect(convert("08:30:00", "TIME")).toBe("08:30:00");
    expect(convert("14:45", "TIME")).toBe("14:45");
  });

  it("trata TIME nulo corretamente", () => {
    expect(convert("", "TIME")).toBeNull();
    expect(convert(null, "TIME")).toBeNull();
  });
});
