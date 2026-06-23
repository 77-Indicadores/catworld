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
});
