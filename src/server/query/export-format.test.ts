import { describe, expect, it } from "vitest";
import { csvField, csvMinimalField, csvTruncationRow, exactNumber, neutralizeFormula, xlsxCell } from "./export-format";

describe("export-format", () => {
  it("csv: bigint, objeto, Date, null e aspas", () => {
    expect(csvField(10n)).toBe('"10"');
    expect(csvField({ a: 1n })).toBe('"{""a"":""1""}"');
    expect(csvField(new Date("2024-01-02T03:04:05Z"), true)).toBe('"2024-01-02T03:04:05.000Z"');
    expect(csvField(null)).toBe('""');
    expect(csvField('a"b')).toBe('"a""b"');
  });
  it("xlsx: bigint e objeto viram texto; numero/data ficam nativos", () => {
    expect(xlsxCell(5n)).toBe("5");
    expect(xlsxCell({ x: 1 })).toBe('{"x":1}');
    expect(xlsxCell(3)).toBe(3);
    const d = new Date(0);
    expect(xlsxCell(d)).toBe(d);
    expect(xlsxCell(undefined)).toBeNull();
  });
});

describe("CSV injection (formulas)", () => {
  it.each(["=1+1", "+cmd|' /C calc'!A0", "-2+3", "@SUM(A1)", "\tcmd", "\rcmd", "=HYPERLINK(\"http://x\")"])("neutraliza %j", (v) => {
    expect(csvField(v)).toMatch(/^"'/);
  });
  it("texto normal, vazio e numeros nao sao tocados", () => {
    expect(csvField("abc")).toBe('"abc"');
    expect(csvField("")).toBe('""');
    expect(csvField(-5)).toBe('"-5"');            // numero JS
    expect(csvField("-5")).toBe('"-5"');          // bigint/decimal normalizado (texto numerico)
    expect(csvField("+3.25")).toBe('"+3.25"');
    expect(csvField("-1e3")).toBe('"-1e3"');
    expect(csvField(new Date("2024-01-02T03:04:05Z"), true)).toBe('"2024-01-02T03:04:05.000Z"');
  });
  it("opt-out explicito (formulaSafe=false)", () => {
    expect(csvField("=1+1", { formulaSafe: false })).toBe('"=1+1"');
  });
  it("neutralizeFormula so age em texto", () => {
    expect(neutralizeFormula(5n, "-5")).toBe("-5");
    expect(neutralizeFormula("=x", "=x")).toBe("'=x");
  });
  it("CR solto e quebra de linha ficam entre aspas (minimo e sempre-aspas)", () => {
    expect(csvField("a\rb")).toBe('"a\rb"'); // CR solto dentro das aspas; nao comeca com CR: sem prefixo
    expect(csvMinimalField("a\rb", ";")).toBe('"a\rb"');
    expect(csvMinimalField("a\nb", ";")).toBe('"a\nb"');
    expect(csvMinimalField("a;b", ";")).toBe('"a;b"');
    expect(csvMinimalField("plain", ";")).toBe("plain");
    expect(csvMinimalField("=1", ";")).toBe("'=1");
  });
  it("linha de truncamento tem o mesmo numero de campos", () => {
    const row = csvTruncationRow(10000, 3);
    expect(row.split(",").length).toBe(3);
    expect(row).toContain("TRUNCADO");
  });
});

describe("xlsx: BIGINT/DECIMAL numericos so quando exatos", () => {
  it("exatos viram numero", () => {
    expect(xlsxCell("123", "bigint")).toBe(123);
    expect(xlsxCell("10.50", "decimal")).toBe(10.5);
    expect(xlsxCell("-0.25", "decimal")).toBe(-0.25);
    expect(xlsxCell("9007199254740991", "bigint")).toBe(9007199254740991);
  });
  it("nao exatos ficam texto (nao perdem digitos)", () => {
    expect(xlsxCell("9007199254740993", "bigint")).toBe("9007199254740993");
    expect(xlsxCell("12345678901234567.89", "decimal")).toBe("12345678901234567.89");
    expect(xlsxCell("0.1234567890123456789", "decimal")).toBe("0.1234567890123456789");
  });
  it("texto de coluna comum (CEP com zero a esquerda) nunca vira numero", () => {
    expect(xlsxCell("01234", "other")).toBe("01234");
    expect(xlsxCell("01234")).toBe("01234");
  });
  it("exactNumber", () => {
    expect(exactNumber("1.10")).toBe(1.1);
    expect(exactNumber("abc")).toBeNull();
    expect(exactNumber("1e3")).toBeNull();
  });
  it("neutralizacao: sem falso positivo em telefone/moeda/menção; mantem formula real", () => {
    for (const ok of ["+55 11 99999-9999", "-$1,234.50", "-1.234,56", "-", "+", "@user", "-1 days", "(11) 99999-9999", "+5511999999999"]) {
      expect(neutralizeFormula(ok, ok), ok).toBe(ok);
    }
    for (const bad of ["=1+1", "=cmd|' /C calc'!A0", "@SUM(A1:A2)", "+cmd|'/c calc'!A0", "-SUM(A1)", "-(1+1)", "+HYPERLINK(\"x\")", "\tx", "\rx", "-1+cmd|'x'!A1"]) {
      expect(neutralizeFormula(bad, bad), bad).toBe(`'${bad}`);
    }
  });
});
