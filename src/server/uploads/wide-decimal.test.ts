import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertForTds, isWideDecimal, ValueConversionError } from "./convert-values";
import { previewFile } from "./parser";

// Achado contra SQL Server real: DECIMAL com mais de 15 dígitos não pode ir pelo bulk tipado (o driver passa por Number).
describe("DECIMAL largo no TDS", () => {
  it("só é 'largo' quando o ARQUIVO precisa de mais de 15 dígitos (o piso 18,4 sozinho não muda o caminho)", () => {
    expect(isWideDecimal({ sqlType: "DECIMAL(18,4)", decimalDigits: 6 })).toBe(false);
    expect(isWideDecimal({ sqlType: "DECIMAL(18,4)", decimalDigits: 15 })).toBe(false);
    expect(isWideDecimal({ sqlType: "DECIMAL(18,4)", decimalDigits: 18 })).toBe(true);
    expect(isWideDecimal({ sqlType: "DECIMAL(38,10)", decimalDigits: 30 })).toBe(true);
    // mapeamento antigo (sem decimalDigits): cai na precisao do tipo (o pior caso), para nunca depender de Number acima de 15 digitos
    expect(isWideDecimal({ sqlType: "DECIMAL(18,4)" })).toBe(true);
    expect(isWideDecimal({ sqlType: "DECIMAL(38,10)" })).toBe(true);
    expect(isWideDecimal({ sqlType: "DECIMAL(12,2)" })).toBe(false);
    expect(isWideDecimal({ sqlType: "DECIMAL" })).toBe(true);                  // DECIMAL sem parametros = legado (18,4)
    expect(isWideDecimal({ sqlType: "BIGINT", decimalDigits: 20 })).toBe(false);
  });
  it("largo: sai como texto exato; estreito: continua Number", () => {
    expect(convertForTds("12345678901234.5678", { sqlType: "DECIMAL(18,4)", decimalSep: ".", decimalDigits: 18 })).toBe("12345678901234.5678");
    expect(convertForTds("-99999999999999.9999", { sqlType: "DECIMAL(18,4)", decimalSep: ".", decimalDigits: 18 })).toBe("-99999999999999.9999");
    expect(convertForTds("1234.5678", { sqlType: "DECIMAL(18,4)", decimalSep: ".", decimalDigits: 8 })).toBe(1234.5678);
  });
  it("mapeamento antigo (sem decimalDigits) com valor de 18 digitos: texto exato (antes lancava); o que nao cabe no tipo ainda lanca", () => {
    expect(convertForTds("12345678901234.5678", { sqlType: "DECIMAL(18,4)", decimalSep: "." })).toBe("12345678901234.5678");
    expect(convertForTds("1234567890123456789012.5", { sqlType: "DECIMAL(38,10)", decimalSep: "." })).toBe("1234567890123456789012.5");
    expect(() => convertForTds("1.23456", { sqlType: "DECIMAL(18,4)", decimalSep: "." })).toThrow(ValueConversionError);
  });
  it("valor que não cabe no tipo declarado lança mesmo sendo largo", () => {
    expect(() => convertForTds("1.23456", { sqlType: "DECIMAL(18,4)", decimalSep: ".", decimalDigits: 18 })).toThrow(ValueConversionError);
  });
  it("o parser registra os dígitos necessários por coluna, do arquivo inteiro", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wd-"));
    try {
      const p = join(dir, "t.csv");
      writeFileSync(p, "a,b\nx,1.5\ny,12345678901234.5678\n");
      const cols = (await previewFile(p)).columns;
      expect(cols.find((c) => c.sqlName === "b")).toMatchObject({ sqlType: "DECIMAL(18,4)", decimalDigits: 18 });
      writeFileSync(p, "a,b\nx,1.5\ny,22.25\n");
      expect((await previewFile(p)).columns.find((c) => c.sqlName === "b")).toMatchObject({ sqlType: "DECIMAL(18,4)", decimalDigits: 4 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
