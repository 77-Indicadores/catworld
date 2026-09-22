import { describe, expect, it } from "vitest";
import { DECIMAL_MAX_PRECISION, decimalFits, fitDecimal, formatDecimalType, parseDecimalType, physicalDecimal } from "./decimal-type";

describe("parseDecimalType", () => {
  it("lê DECIMAL(p,s) e NUMERIC(p,s); sem parâmetros é o legado (18,4)", () => {
    expect(parseDecimalType("DECIMAL(18,4)")).toEqual({ precision: 18, scale: 4 });
    expect(parseDecimalType("decimal( 38 , 10 )")).toEqual({ precision: 38, scale: 10 });
    expect(parseDecimalType("NUMERIC(10,2)")).toEqual({ precision: 10, scale: 2 });
    expect(parseDecimalType("DECIMAL")).toEqual({ precision: 18, scale: 4 });
  });
  it("recusa o que não é decimal ou está fora da faixa", () => {
    for (const bad of ["BIGINT", "NVARCHAR(MAX)", "DECIMAL(39,2)", "DECIMAL(5,6)", "DECIMAL(0,0)", "DECIMAL(a,b)", ""]) expect(parseDecimalType(bad)).toBeNull();
  });
});

describe("physicalDecimal", () => {
  it("Postgres NUMERIC, SQL Server DECIMAL; o legado 18,4 continua igual", () => {
    expect(physicalDecimal("DECIMAL(18,4)", "postgres")).toBe("NUMERIC(18,4)");
    expect(physicalDecimal("DECIMAL(30,12)", "postgres")).toBe("NUMERIC(30,12)");
    expect(physicalDecimal("DECIMAL(30,12)", "mssql")).toBe("DECIMAL(30,12)");
  });
  it("parâmetro inválido cai no legado (nunca em texto nem em precisão maior que o suportado)", () => {
    expect(physicalDecimal("DECIMAL(99,2)", "postgres")).toBe("NUMERIC(18,4)");
  });
});

describe("fitDecimal", () => {
  it("escolhe o menor tipo que guarda todos os valores", () => {
    expect(fitDecimal(["1.5", "22.25"])).toEqual({ precision: 4, scale: 2 });
    expect(fitDecimal(["0.000123"])).toEqual({ precision: 7, scale: 6 });
    expect(fitDecimal(["12345678901234.5678"])).toEqual({ precision: 18, scale: 4 });
    expect(fitDecimal(["-99999999999999.9999", "1"])).toEqual({ precision: 18, scale: 4 });
  });
  it("zeros à direita não aumentam a escala; zeros à esquerda não aumentam os inteiros", () => {
    expect(fitDecimal(["1.5000", "2.50"])).toEqual({ precision: 2, scale: 1 });
    expect(fitDecimal(["0001.5"])).toEqual({ precision: 2, scale: 1 });
  });
  it("inteiros de 15+ dígitos (antes viravam NULL) agora cabem", () => {
    expect(fitDecimal(["123456789012345.5"])).toEqual({ precision: 16, scale: 1 });
  });
  it("mais de 38 dígitos: null (quem chama usa TEXT), nunca arredonda", () => {
    expect(fitDecimal(["1".repeat(30) + "." + "1".repeat(10)])).toBeNull();
    expect(DECIMAL_MAX_PRECISION).toBe(38);
  });
  it("valor que não é número: null", () => {
    expect(fitDecimal(["1.5", "abc"])).toBeNull();
    expect(fitDecimal([""])).toBeNull();
    expect(fitDecimal(["1.2.3"])).toBeNull();
  });
  it("formatDecimalType", () => expect(formatDecimalType({ precision: 7, scale: 6 })).toBe("DECIMAL(7,6)"));
});

describe("decimalFits", () => {
  const t = { precision: 18, scale: 4 };
  it("exato, sem passar por Number", () => {
    expect(decimalFits("12345678901234.5678", t)).toBe(true);
    expect(decimalFits("1.23456", t)).toBe(false);          // escala maior: arredondaria
    expect(decimalFits("123456789012345.5", t)).toBe(false); // inteiros demais
    expect(decimalFits("0.00001", t)).toBe(false);
    expect(decimalFits("1.50000", t)).toBe(true);            // zeros à direita cabem
    expect(decimalFits("abc", t)).toBe(false);
  });
});
