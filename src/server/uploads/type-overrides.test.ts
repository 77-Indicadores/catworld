// @vitest-environment node
/** TIP-06: overrides de tipo nunca são ignorados em silêncio nem viram NULL. */
import { describe, expect, it } from "vitest";
import { applyTypeOverrides, TypeOverrideError, type ParsedColumn } from "./parser";
import { normalizeTypeOverride } from "./type-override";
import { convertForPg, ValueConversionError } from "./convert-values";

const cols = (): ParsedColumn[] => [
  { originalName: "Valor Total", sqlName: "valor_total", sqlType: "NVARCHAR(MAX)", nullable: true },
  { originalName: "amb", sqlName: "amb", sqlType: "NVARCHAR(MAX)", nullable: true, decimalAmbiguous: true, dateAmbiguous: true },
];

describe("applyTypeOverrides", () => {
  it("aplica por sqlName ou originalName (sem diferenciar caixa) e normaliza DECIMAL", () => {
    const c = cols();
    const r = applyTypeOverrides(c, { "VALOR TOTAL": "decimal(10, 2)" });
    expect(r.applied).toEqual(["valor_total"]);
    expect(c[0]!.sqlType).toBe("DECIMAL(10,2)");
    applyTypeOverrides(c, { valor_total: "numeric(12,3)" });
    expect(c[0]!.sqlType).toBe("DECIMAL(12,3)");
    applyTypeOverrides(c, { valor_total: "DECIMAL" });
    expect(c[0]!.sqlType).toBe("DECIMAL(18,4)");
  });
  it("coluna desconhecida LANÇA (antes: ignorada)", () => {
    expect(() => applyTypeOverrides(cols(), { nao_existe: "BIGINT" })).toThrow(TypeOverrideError);
    expect(() => applyTypeOverrides(cols(), { nao_existe: "BIGINT" })).toThrow(/nao_existe/);
  });
  it("tipo inválido LANÇA e nada é aplicado", () => {
    const c = cols();
    for (const t of ["FLOAT", "INT", "DECIMAL(99,99)", "DECIMAL(5,9)", "DECIMAL(0,0)", "VARCHAR(10)", ""]) {
      expect(() => applyTypeOverrides(c, { valor_total: t })).toThrow(TypeOverrideError);
    }
    expect(c[0]!.sqlType).toBe("NVARCHAR(MAX)");
  });
  it("um erro entre vários overrides não aplica nenhum", () => {
    const c = cols();
    expect(() => applyTypeOverrides(c, { valor_total: "BIGINT", xxx: "DATE" })).toThrow();
    expect(c[0]!.sqlType).toBe("NVARCHAR(MAX)");
  });
  it("override de DECIMAL/DATE sobre coluna com convenção ambígua é recusado", () => {
    expect(() => applyTypeOverrides(cols(), { amb: "DECIMAL(10,2)" })).toThrow(/ambíguos/);
    expect(() => applyTypeOverrides(cols(), { amb: "DATE" })).toThrow(/ambíguas/);
    expect(applyTypeOverrides(cols(), { amb: "NVARCHAR(MAX)" }).applied).toEqual(["amb"]);
  });
  it("sem overrides: nada muda", () => {
    expect(applyTypeOverrides(cols(), null).applied).toEqual([]);
    expect(applyTypeOverrides(cols(), {}).applied).toEqual([]);
  });
});

describe("normalizeTypeOverride (validação da API)", () => {
  it("aceita os tipos canônicos e rejeita o resto", () => {
    expect(normalizeTypeOverride("bigint")).toBe("BIGINT");
    expect(normalizeTypeOverride(" decimal ( 38 , 10 ) ")).toBe("DECIMAL(38,10)");
    expect(normalizeTypeOverride("DECIMAL(39,2)")).toBeNull();
    expect(normalizeTypeOverride("FLOAT")).toBeNull();
    expect(normalizeTypeOverride("TEXT")).toBeNull();
  });
});

describe("override honrado na conversão", () => {
  it("DECIMAL(10,2) recusa 3 casas e valor grande demais (não arredonda, não vira NULL)", () => {
    const c = { sqlType: "DECIMAL(10,2)", decimalSep: "." as const };
    expect(convertForPg("12.34", c)).toBe("12.34");
    expect(() => convertForPg("12.345", c)).toThrow(ValueConversionError);
    expect(() => convertForPg("123456789.00", c)).toThrow(ValueConversionError);
  });
});
