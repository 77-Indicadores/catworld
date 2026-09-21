// @vitest-environment node
/** XLSX (TIP-08): nenhuma célula vira NULL/[object Object]/hora do fuso do servidor; nenhuma linha é ignorada em silêncio. */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { previewFile, rowsFromFile } from "./parser";
import { cellValueText, XlsxValueError } from "./xlsx-values";

const dir = mkdtempSync(join(tmpdir(), "cw-xlsx-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let seq = 0;

async function book(build: (wb: ExcelJS.Workbook) => void): Promise<string> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  const p = join(dir, `f${seq++}.xlsx`);
  await wb.xlsx.writeFile(p);
  return p;
}
async function read(path: string) {
  const prev = await previewFile(path);
  const rows: Record<string, unknown>[] = [];
  for await (const r of rowsFromFile(path, prev.columns, { ext: ".xlsx" })) rows.push(r);
  return { prev, rows };
}

describe("cellValueText (função pura)", () => {
  it("texto, número, booleano", () => {
    expect(cellValueText("a")).toBe("a");
    expect(cellValueText(12.5)).toBe("12.5");
    expect(cellValueText(true)).toBe("true");
    expect(cellValueText(null)).toBe("");
  });
  it("rich text concatena os trechos (antes: NULL)", () => {
    expect(cellValueText({ richText: [{ text: "Olá " }, { text: "mundo", font: { bold: true } }] })).toBe("Olá mundo");
  });
  it("hiperlink devolve o texto exibido", () => {
    expect(cellValueText({ text: "site", hyperlink: "http://x" })).toBe("site");
    expect(cellValueText({ text: { richText: [{ text: "a" }, { text: "b" }] }, hyperlink: "http://x" })).toBe("ab");
  });
  it("fórmula: usa o resultado (número, texto, data em ISO UTC, erro)", () => {
    expect(cellValueText({ formula: "A1+1", result: 5 })).toBe("5");
    expect(cellValueText({ formula: "A1&B1", result: "ab" })).toBe("ab");
    expect(cellValueText({ formula: "TODAY()", result: new Date("2026-05-04T00:00:00Z") })).toBe("2026-05-04T00:00:00.000Z");
    expect(cellValueText({ formula: "1/0", result: { error: "#DIV/0!" } })).toBe("#DIV/0!");
    expect(cellValueText({ sharedFormula: "A1", result: 7 })).toBe("7");
  });
  it("fórmula sem resultado calculado é ERRO nomeando a célula", () => {
    expect(() => cellValueText({ formula: "A1+1" }, "C4")).toThrow(XlsxValueError);
    expect(() => cellValueText({ formula: "A1+1" }, "C4")).toThrow(/C4/);
  });
  it("erro de célula vira texto explícito, nunca [object Object]", () => {
    expect(cellValueText({ error: "#N/A" })).toBe("#N/A");
  });
  it("tipo desconhecido lança", () => {
    expect(() => cellValueText({ foo: 1 }, "A1")).toThrow(XlsxValueError);
  });
});

describe("XLSX real", () => {
  it("rich text, fórmula, erro e data chegam como o arquivo tem (TZ-independente)", async () => {
    const p = await book((wb) => {
      const ws = wb.addWorksheet("dados");
      ws.addRow(["id", "texto", "calc", "quando", "erro"]);
      ws.addRow([1, { richText: [{ text: "ab" }, { text: "cd", font: { bold: true } }] }, { formula: "1+1", result: 2 }, new Date("2026-05-04T00:00:00Z"), { error: "#N/A" }]);
      ws.addRow([2, "plain", { formula: "2+2", result: 4 }, new Date("2026-05-05T13:45:00Z"), "ok"]);
    });
    const { prev, rows } = await read(p);
    expect(prev.rowCount).toBe(2);
    expect(rows[0]).toMatchObject({ id: "1", texto: "abcd", calc: "2", erro: "#N/A" });
    expect(String(rows[0]!.quando)).toBe("2026-05-04T00:00:00.000Z");
    expect(rows[1]).toMatchObject({ texto: "plain", calc: "4", erro: "ok" });
    expect(String(rows[1]!.quando)).toBe("2026-05-05T13:45:00.000Z");
    expect(prev.columns.find((c) => c.sqlName === "erro")!.sqlType).toBe("NVARCHAR(MAX)");
  });
  it("linhas totalmente vazias (no meio e no fim) não viram registro", async () => {
    const p = await book((wb) => {
      const ws = wb.addWorksheet("d");
      ws.addRow(["id", "nome"]);
      ws.addRow([1, "a"]);
      ws.getRow(3).values = [];      // vazia
      ws.addRow([3, "c"]);           // vai para a linha 4
      ws.getRow(6).values = [null, "  "];   // só espaços
    });
    const { prev, rows } = await read(p);
    expect(prev.rowCount).toBe(2);
    expect(rows.map((r) => r.id)).toEqual(["1", "3"]);
  });
  it("células mescladas: só a mestra tem valor (antes: valor repetido nas outras)", async () => {
    const p = await book((wb) => {
      const ws = wb.addWorksheet("d");
      ws.addRow(["a", "b", "c"]);
      ws.addRow(["x", "y", "z"]);
      ws.addRow(["m", null, "n"]);
      ws.mergeCells("A3:B3");
    });
    const { rows } = await read(p);
    expect(rows[1]).toMatchObject({ a: "m", b: "", c: "n" });
  });
  it("dados em duas abas: RECUSADO (nunca importa só a primeira em silêncio)", async () => {
    const p = await book((wb) => {
      wb.addWorksheet("jan").addRows([["id"], [1]]);
      wb.addWorksheet("fev").addRows([["id"], [2]]);
    });
    await expect(previewFile(p)).rejects.toThrow(/mais de uma aba/);
  });
  it("aba extra VAZIA não atrapalha; dados só na 2ª aba é recusado", async () => {
    const ok = await book((wb) => { wb.addWorksheet("a").addRows([["id"], [1]]); wb.addWorksheet("vazia"); });
    expect((await read(ok)).prev.rowCount).toBe(1);
    const bad = await book((wb) => { wb.addWorksheet("vazia"); wb.addWorksheet("b").addRows([["id"], [1]]); });
    await expect(previewFile(bad)).rejects.toThrow(/não é a primeira/);
  });
  it("fórmula sem resultado calculado falha o preview nomeando a célula", async () => {
    const p = await book((wb) => {
      const ws = wb.addWorksheet("d");
      ws.addRow(["id", "v"]);
      ws.addRow([1, { formula: "1+1" } as unknown as ExcelJS.CellValue]);
    });
    await expect(previewFile(p)).rejects.toThrow(/B2/);
  });
  it("regressão: planilha simples continua igual (texto, número, data ISO, tipos)", async () => {
    const p = await book((wb) => {
      const ws = wb.addWorksheet("d");
      ws.addRow(["qtd", "nome", "valor", "dia"]);
      ws.addRow([1, "ana", 10.5, new Date("2026-01-15T00:00:00Z")]);
      ws.addRow([2, "bia", 3.25, new Date("2026-02-20T00:00:00Z")]);
    });
    const { prev, rows } = await read(p);
    expect(prev.columns.map((c) => c.sqlType)).toEqual(["BIGINT", "NVARCHAR(MAX)", "DECIMAL(18,4)", "DATETIME2"]);
    expect(rows.map((r) => [r.qtd, r.nome, r.valor])).toEqual([["1", "ana", "10.5"], ["2", "bia", "3.25"]]);
  });
});
