// @vitest-environment node
/**
 * Fidelidade de tipos e valores (TIP-01/02/06/11/13/15): o Catworld não pode guardar valor diferente do arquivo.
 * Oráculo: o texto do arquivo. Tudo que não cabe exato vira TEXT ou ERRO, nunca arredondado/NULL/reinterpretado.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewFile } from "./parser";
import { convertForPg, convertForTds, ValueConversionError } from "./convert-values";
import { normalizeDateLike } from "./date-normalize";

const dir = mkdtempSync(join(tmpdir(), "cw-tipfid-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let seq = 0;

/** coluna única `v` (mais um id para o arquivo ter forma de tabela) */
async function colOf(values: string[]) {
  const p = join(dir, `f${seq++}.csv`);
  writeFileSync(p, ["n,v", ...values.map((v, i) => `${i + 1},${v.includes(",") && !v.startsWith('"') ? `"${v}"` : v}`)].join("\n") + "\n");
  const prev = await previewFile(p);
  return prev.columns[1]!;
}

describe("TIP-01: DECIMAL(p,s) inferido do arquivo inteiro", () => {
  it("escala maior que 4 não é arredondada: 0.000123 cabe", async () => {
    const c = await colOf(["0.000123", "1.5"]);
    expect(c.sqlType).toBe("DECIMAL(20,6)");
    expect(convertForPg("0.000123", c)).toBe("0.000123");
  });
  it("15+ dígitos inteiros não viram NULL: alarga a precisão", async () => {
    const c = await colOf(["123456789012345.5", "1.25"]);
    expect(c.sqlType).toMatch(/^DECIMAL\(\d+,\d+\)$/);
    expect(convertForPg("123456789012345.5", c)).toBe("123456789012345.5");
  });
  it("não cabe em 38 dígitos: TEXT (exato), nunca arredondado", async () => {
    const c = await colOf(["12345678901234567890123456789012345.5678", "1.5"]);
    expect(c.sqlType).toBe("NVARCHAR(MAX)");
  });
  it("legado preservado: dados que cabem em (18,4) continuam DECIMAL(18,4)", async () => {
    const c = await colOf(["10.50", "3.1415", "-2.5"]);
    expect(c.sqlType).toBe("DECIMAL(18,4)");
    expect(convertForPg("10.50", c)).toBe("10.50");
    expect(convertForPg("-2.5", c)).toBe("-2.5");
  });
  it("número vem como texto do arquivo, sem passar por Number (0.1+0.2, 1e21 e 2^53+1)", () => {
    const c = { sqlType: "DECIMAL(38,2)", decimalSep: "." as const };
    expect(convertForPg("9007199254740993.10", c)).toBe("9007199254740993.10");
    expect(convertForPg("12345678901234567890123456.99", c)).toBe("12345678901234567890123456.99");
  });
  it("valor que não cabe no DECIMAL declarado LANÇA (não vira NULL nem arredonda)", () => {
    const c = { sqlType: "DECIMAL(10,2)", decimalSep: "." as const };
    expect(() => convertForPg("1.234", c)).toThrow(ValueConversionError);
    expect(() => convertForPg("123456789.00", c)).toThrow(ValueConversionError);
    expect(() => convertForPg("abc", c)).toThrow(ValueConversionError);
    expect(convertForPg("12345678.90", c)).toBe("12345678.90");
  });
});

describe("TIP-02: separador decimal/milhar decidido por coluna", () => {
  it("vírgula decimal BR: 1.234,56 e 0,5 na mesma coluna", async () => {
    const c = await colOf(['"1.234,56"', "0,5", "10"]);
    expect(c.decimalSep).toBe(",");
    expect(convertForPg("1.234,56", c)).toBe("1234.56");
    expect(convertForPg("0,5", c)).toBe("0.5");
  });
  it("ponto decimal US: 1,234.56", async () => {
    const c = await colOf(['"1,234.56"', "2.5"]);
    expect(c.decimalSep).toBe(".");
    expect(convertForPg("1,234.56", c)).toBe("1234.56");
  });
  it("1.234 sozinho é ambíguo (1234 ou 1,234): a coluna fica TEXT", async () => {
    const c = await colOf(["1.234", "2.500"]);
    expect(c.sqlType).toBe("NVARCHAR(MAX)");
    expect(c.decimalAmbiguous).toBe(true);
  });
  it("coluna inteira '1,234' / '12' / '2,500' não vira 1.234", async () => {
    const c = await colOf(['"1,234"', "12", '"2,500"']);
    expect(c.sqlType).toBe("NVARCHAR(MAX)");
  });
  it("uma evidência na coluna desambigua: 1.234 + 2,5 => vírgula decimal, 1.234 vale 1234", async () => {
    const c = await colOf(["1.234", "2,5"]);
    expect(c.decimalSep).toBe(",");
    expect(convertForPg("1.234", c)).toBe("1234");
  });
  it("evidência de milhar por separador repetido: 1,234,567 e 1,234", async () => {
    const c = await colOf(['"1,234,567"', '"1,234"']);
    expect(c.decimalSep).toBe(".");
    expect(convertForPg("1,234", c)).toBe("1234");
  });
  it("convenções conflitantes na mesma coluna (1,5 e 1.5): TEXT", async () => {
    const c = await colOf(['"1,5"', "1.5"]);
    expect(c.sqlType).toBe("NVARCHAR(MAX)");
  });
  it("agrupamento inválido de milhar: TEXT", async () => {
    const c = await colOf(['"1,23,456"', "2"]);
    expect(c.sqlType).toBe("NVARCHAR(MAX)");
  });
  it("inteiros puros continuam BIGINT e valor idêntico", async () => {
    const c = await colOf(["1", "-25", "9223372036854775807"]);
    expect(c.sqlType).toBe("BIGINT");
    expect(convertForPg("-25", c)).toBe("-25");
  });
  it("mapeamento antigo (sem decimalSep): sem Number e sem NULL; o que não cabe lança", () => {
    const legacy = { sqlType: "DECIMAL(18,4)" };
    expect(convertForPg("1.234,56", legacy)).toBe("1234.56");
    expect(convertForPg("1,234.56", legacy)).toBe("1234.56");
    expect(() => convertForPg("0.000123", legacy)).toThrow(ValueConversionError);
  });
});

describe("TIP-13: zero à esquerda com sinal", () => {
  it("-007 e 007 ficam texto", async () => {
    expect((await colOf(["-007", "5"])).sqlType).toBe("NVARCHAR(MAX)");
    expect((await colOf(["007", "5"])).sqlType).toBe("NVARCHAR(MAX)");
  });
  it("-0 e 0 continuam números", async () => {
    expect((await colOf(["0", "-5"])).sqlType).toBe("BIGINT");
  });
});

describe("TIP-15: TIME com faixa", () => {
  it("25:00 não é TIME", async () => {
    expect((await colOf(["25:00", "10:00"])).sqlType).toBe("NVARCHAR(MAX)");
    expect((await colOf(["12:60"])).sqlType).toBe("NVARCHAR(MAX)");
    expect((await colOf(["12:00:61"])).sqlType).toBe("NVARCHAR(MAX)");
  });
  it("horas válidas continuam TIME", async () => {
    expect((await colOf(["00:00", "23:59:59", "9:05"])).sqlType).toBe("TIME");
  });
});

describe("TIP-11: datas — convenção por coluna e offset", () => {
  it("dd/mm resolvido por outro valor da coluna (31/01 prova dd/mm): 04/05/2026 = 4 de maio", async () => {
    const c = await colOf(["04/05/2026", "31/01/2026"]);
    expect(c.sqlType).toBe("DATE");
    expect(c.dateOrder).toBe("dmy");
    expect(convertForPg("04/05/2026", c)).toBe("2026-05-04");
  });
  it("mm/dd resolvido pela coluna (01/31 prova mm/dd): 04/05/2026 = 5 de abril, nunca por valor", async () => {
    const c = await colOf(["04/05/2026", "01/31/2026"]);
    expect(c.dateOrder).toBe("mdy");
    expect(convertForPg("04/05/2026", c)).toBe("2026-04-05");
  });
  it("todas as datas ambíguas (04/05, 10/02): TEXT, sem adivinhar", async () => {
    const c = await colOf(["04/05/2026", "10/02/2026"]);
    expect(c.sqlType).toBe("NVARCHAR(MAX)");
    expect(c.dateAmbiguous).toBe(true);
  });
  it("dd/mm e mm/dd mutuamente incompatíveis na coluna (31/01 e 01/31): TEXT", async () => {
    expect((await colOf(["31/01/2026", "01/31/2026"])).sqlType).toBe("NVARCHAR(MAX)");
  });
  it("datas ISO nunca são ambíguas", async () => {
    const c = await colOf(["2026-05-04", "2026-01-02"]);
    expect(c.sqlType).toBe("DATE");
  });
  it("offset: Z e +00:00 são UTC e saem sem sufixo; -03:00 não é data (TEXT)", async () => {
    expect(normalizeDateLike("2026-05-04T10:00:00Z")).toBe("2026-05-04T10:00:00");
    expect(normalizeDateLike("2026-05-04T10:00:00+00:00")).toBe("2026-05-04T10:00:00");
    expect(normalizeDateLike("2026-05-04T10:00:00-03:00")).toBeNull();
    const c = await colOf(["2026-05-04T10:00:00-03:00"]);
    expect(c.sqlType).toBe("NVARCHAR(MAX)");
  });
  it("override para DATETIME2 de valor com offset -03:00 lança nos DOIS caminhos (mesma regra)", () => {
    const c = { sqlType: "DATETIME2" };
    expect(() => convertForPg("2026-05-04T10:00:00-03:00", c)).toThrow(ValueConversionError);
    expect(() => convertForTds("2026-05-04T10:00:00-03:00", c)).toThrow(ValueConversionError);
  });
});

describe("TIP-06: valor não vazio que não converte é ERRO, nunca NULL", () => {
  it("BIGINT/DATE/DATETIME2/TIME inválidos lançam", () => {
    expect(() => convertForPg("12abc", { sqlType: "BIGINT" })).toThrow(ValueConversionError);
    expect(() => convertForPg("99999999999999999999", { sqlType: "BIGINT" })).toThrow(ValueConversionError);
    expect(() => convertForPg("31/02/2026", { sqlType: "DATE" })).toThrow(ValueConversionError);
    expect(() => convertForPg("ontem", { sqlType: "DATETIME2" })).toThrow(ValueConversionError);
    expect(() => convertForPg("25:00", { sqlType: "TIME" })).toThrow(ValueConversionError);
  });
  it("vazio continua NULL (regra existente)", () => {
    expect(convertForPg("", { sqlType: "BIGINT" })).toBeNull();
    expect(convertForPg("   ", { sqlType: "DATE" })).toBeNull();
    expect(convertForPg(null, { sqlType: "DECIMAL(18,4)" })).toBeNull();
    expect(convertForPg("", { sqlType: "NVARCHAR(MAX)" })).toBeNull();
  });
  it("texto: espaços aparados como sempre; NUL removido; só-NUL lança", () => {
    expect(convertForPg("  ab c ", { sqlType: "NVARCHAR(MAX)" })).toBe("ab c");
    expect(convertForPg("a\x00b", { sqlType: "NVARCHAR(MAX)" })).toBe("ab");
    expect(() => convertForPg("\x00\x00", { sqlType: "NVARCHAR(MAX)" })).toThrow(ValueConversionError);
  });
  it("regressão: datas/horas válidas idênticas ao comportamento anterior", () => {
    expect(convertForPg("2026-05-04", { sqlType: "DATE" })).toBe("2026-05-04");
    expect(convertForPg("15/01/2026 08:30", { sqlType: "DATETIME2", dateOrder: "dmy" })).toBe("2026-01-15 08:30");
    expect(convertForPg("2023-01-15 08:30:00.1234567", { sqlType: "DATETIME2" })).toBe("2023-01-15 08:30:00.1234567");
    expect(convertForPg("08:30:15", { sqlType: "TIME" })).toBe("08:30:15");
  });
});

describe("TIP-09: convertForTds (função pura; ponta a ponta exige SQL Server real)", () => {
  it("BIGINT negativo não vira NULL", () => {
    expect(convertForTds("-5", { sqlType: "BIGINT" })).toBe(-5n);
    expect(convertForTds("-9223372036854775808", { sqlType: "BIGINT" })).toBe(-9223372036854775808n);
  });
  it("BIGINT > 2^53 sai como bigint exato", () => {
    expect(convertForTds("9007199254740993", { sqlType: "BIGINT" })).toBe(9007199254740993n);
    expect(convertForTds("9223372036854775807", { sqlType: "BIGINT" })).toBe(9223372036854775807n);
  });
  it("BIGINT inválido ou fora de faixa lança", () => {
    expect(() => convertForTds("9223372036854775808", { sqlType: "BIGINT" })).toThrow(ValueConversionError);
    expect(() => convertForTds("1.5", { sqlType: "BIGINT" })).toThrow(ValueConversionError);
  });
  it("datetime sem fuso é UTC puro, independe do TZ do processo", () => {
    const d = convertForTds("2023-01-15 08:30:00", { sqlType: "DATETIME2" }) as Date;
    expect(d.toISOString()).toBe("2023-01-15T08:30:00.000Z");
    const dt = convertForTds("15/01/2023 08:30", { sqlType: "DATETIME2", dateOrder: "dmy" }) as Date;
    expect(dt.toISOString()).toBe("2023-01-15T08:30:00.000Z");
    expect((convertForTds("2023-01-15", { sqlType: "DATE" }) as Date).toISOString()).toBe("2023-01-15T00:00:00.000Z");
    expect((convertForTds("08:30:15.250", { sqlType: "TIME" }) as Date).toISOString()).toBe("1970-01-01T08:30:15.250Z");
  });
  it("fração além de milissegundos lança (o driver não grava); zeros à direita passam", () => {
    expect(() => convertForTds("2023-01-15 08:30:00.1234567", { sqlType: "DATETIME2" })).toThrow(ValueConversionError);
    expect((convertForTds("2023-01-15 08:30:00.0000000", { sqlType: "DATETIME2" }) as Date).toISOString()).toBe("2023-01-15T08:30:00.000Z");
  });
  it("DECIMAL: número exato até 15 dígitos; acima disso lança (driver usa Number)", () => {
    expect(convertForTds("1234.5678", { sqlType: "DECIMAL(18,4)", decimalSep: "." })).toBe(1234.5678);
    expect(() => convertForTds("12345678901234567.5", { sqlType: "DECIMAL(38,4)", decimalSep: "." })).toThrow(ValueConversionError);
    expect(() => convertForTds("0.00012", { sqlType: "DECIMAL(18,4)", decimalSep: "." })).toThrow(ValueConversionError);
  });
});
