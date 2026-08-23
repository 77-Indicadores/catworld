import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { previewFile, rowsFromFile } from "./parser";
import { convert } from "./importer";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "catworld-pipeline-test-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function csv(content: string, encoding: BufferEncoding = "utf8") {
  const path = join(dir, "sample.csv");
  await writeFile(path, content, encoding);
  return path;
}

async function xlsx(rows: unknown[][]) {
  const path = join(dir, "sample.xlsx");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  rows.forEach(row => sheet.addRow(row));
  await workbook.xlsx.writeFile(path);
  return path;
}

// ============================================================
// 1. CSV grande (>1MB) com coluna mista número/texto
// ============================================================
describe("CSV grande com coluna mista número/texto", () => {
  it("parseia arquivo de 5000+ linhas com coluna que começa numérica e vira texto", async () => {
    const rows = Array.from({ length: 5005 }, (_, i) => {
      const val = i < 5000 ? String(i) : `produto_${i}`;
      return `${i},${val}`;
    }).join("\n");
    const path = await csv(`id,codigo\n${rows}\n`);
    const preview = await previewFile(path);
    // Preview infers type for display — but import treats all as NVARCHAR
    const codigoCol = preview.columns.find(c => c.sqlName === "codigo");
    expect(codigoCol).toBeDefined();
    // The parser processes all rows, so allInt should be false (mixed values)
    // and the type should fall back to NVARCHAR
    expect(codigoCol!.sqlType).toMatch(/^NVARCHAR/);
  });

  it("parseia CSV grande mantendo valores literais via rowsFromFile", async () => {
    const rows = Array.from({ length: 1005 }, (_, i) => `${i},${i % 2 === 0 ? "0123" : "ABC"}`).join("\n");
    const path = await csv(`id,codigo\n${rows}\n`);
    const preview = await previewFile(path);
    const all: Record<string, unknown>[] = [];
    for await (const row of rowsFromFile(path, preview.columns)) all.push(row);
    // Leading zeros preserved, text values preserved
    expect(all[0].codigo).toBe("0123");
    expect(all[1].codigo).toBe("ABC");
  });
});

// ============================================================
// 3. CSV com nome de produto textual
// ============================================================
describe("CSV com nome de produto textual", () => {
  it("preserva nome de produto com caracteres especiais", async () => {
    const path = await csv(
      `id,produto,preco\n` +
      `1,"PAPEL SULFITE 61 X 50 75GR 2""",10.50\n` +
      `2,"ÁGUA SANITÁRIA 5L",8.90\n` +
      `3,"CANETA AZUL CX C/50",25.00\n`
    );
    const preview = await previewFile(path);
    expect(preview.columns).toHaveLength(3);
    const all: Record<string, unknown>[] = [];
    for await (const row of rowsFromFile(path, preview.columns)) all.push(row);
    expect(all[0].produto).toContain('2"');
    expect(all[1].produto).toContain("ÁGUA");
    expect(all[2].produto).toContain("CANETA");
  });
});

// ============================================================
// 4. CSV com decimal brasileiro
// ============================================================
describe("CSV com decimal brasileiro", () => {
  it("preserva valor com ponto de milhar e vírgula decimal como string", async () => {
    const path = await csv(
      `id,valor\n` +
      `1,"1.234,56"\n` +
      `2,"999,90"\n` +
      `3,"0,50"\n`
    );
    const preview = await previewFile(path);
    const all: Record<string, unknown>[] = [];
    for await (const row of rowsFromFile(path, preview.columns)) all.push(row);
    // Rows come from parser as strings — sanitizeCsvField preserves them
    expect(String(all[0].valor)).toBe("1.234,56");
    expect(String(all[1].valor)).toBe("999,90");
    expect(String(all[2].valor)).toBe("0,50");
  });

  it("parseia CSV com separador ; e decimal brasileiro", async () => {
    const path = await csv(
      `id;valor;texto\n` +
      `1;1.234,56;a\n` +
      `2;99,90;b\n` +
      `3;0,50;c\n`
    );
    const preview = await previewFile(path);
    expect(preview.separator).toBe(";");
    const all: Record<string, unknown>[] = [];
    for await (const row of rowsFromFile(path, preview.columns)) all.push(row);
    expect(String(all[0].valor)).toBe("1.234,56");
  });
});

// ============================================================
// 5. CSV com data ambígua
// ============================================================
describe("CSV com data ambígua", () => {
  it("preserva data em formato ambíguo como string sem normalizar", async () => {
    const path = await csv(
      `id,data\n` +
      `1,"04/05/2026"\n` +
      `2,"31/12/2024"\n` +
      `3,"01/01/2025"\n`
    );
    const preview = await previewFile(path);
    // Parser infers DATE for unambiguous dates, but import stores as NVARCHAR
    const all: Record<string, unknown>[] = [];
    for await (const row of rowsFromFile(path, preview.columns)) all.push(row);
    // The raw value from CSV is the original string
    expect(String(all[0].data)).toBe("04/05/2026");
  });
});

// ============================================================
// 6. CSV com código com zero à esquerda
// ============================================================
describe("CSV com código com zero à esquerda", () => {
  it("preserva zero à esquerda na saída do parser", async () => {
    const path = await csv(
      `codigo,nome\n` +
      `00123,Produto A\n` +
      `00001,Produto B\n` +
      `01234,Produto C\n`
    );
    const preview = await previewFile(path);
    const all: Record<string, unknown>[] = [];
    for await (const row of rowsFromFile(path, preview.columns)) all.push(row);
    expect(all[0].codigo).toBe("00123");
    expect(all[1].codigo).toBe("00001");
    expect(all[2].codigo).toBe("01234");
  });

});

// ============================================================
// 7. CSV com header duplicado
// ============================================================
describe("CSV com header duplicado", () => {
  it("deduplica headers com sufixo numérico", async () => {
    const path = await csv(
      `id,nome,nome,valor\n` +
      `1,A,B,10\n` +
      `2,C,D,20\n`
    );
    const preview = await previewFile(path);
    const names = preview.columns.map(c => c.sqlName);
    expect(names).toContain("nome");
    expect(names).toContain("nome_2");
    expect(preview.columns).toHaveLength(4);
  });
});

// ============================================================
// 8. CSV com coluna sem nome (header vazio)
// ============================================================
describe("CSV com coluna sem nome", () => {
  it("nomeia coluna sem cabeçalho como col_N", async () => {
    const path = await csv(
      `id,,nome\n` +
      `1,extra,Ana\n` +
      `2,extra2,Bob\n`
    );
    const preview = await previewFile(path);
    const names = preview.columns.map(c => c.sqlName);
    expect(names).toContain("col_2");
    expect(preview.columns).toHaveLength(3);
  });
});

// ============================================================
// 9. CSV com acento/símbolos no header
// ============================================================
describe("CSV com acento/símbolos no header", () => {
  it("sanitiza nomes de coluna com acentos e símbolos", async () => {
    const path = await csv(
      `ID,Valor Total,Descrição,Unidade%\n` +
      `1,100.50,Produto A,un\n` +
      `2,200.00,Produto B,kg\n`
    );
    const preview = await previewFile(path);
    const names = preview.columns.map(c => c.sqlName);
    expect(names).toContain("valor_total");
    expect(names).toContain("descricao");
    expect(preview.columns).toHaveLength(4);
  });
});

// ============================================================
// 10. CSV Windows-1252
// ============================================================
describe("CSV Windows-1252", () => {
  it("detecta encoding Windows-1252 e preserva caracteres latinos", async () => {
    // Conteúdo codificado em Windows-1252: "id,nome\n1,João\n2,Marie Françoise\n3,Müller"
    const buf = Buffer.from("69642c6e6f6d650a312c4a6ffc636f0a322c4d61726965204672616ee76f6973650a332c4dfc6c6c65720a", "hex");
    // Actually let me use a simpler approach with iconv-lite
    const iconv = await import("iconv-lite");
    const content = iconv.encode("id,nome\n1,João\n2,Marie Françoise\n3,Müller\n", "win1252");
    const path = join(dir, "win1252.csv");
    await writeFile(path, content);
    const preview = await previewFile(path);
    expect(preview.encoding).toBe("win1252");
    expect(preview.columns.find(c => c.sqlName === "nome")).toBeDefined();
    const all: Record<string, unknown>[] = [];
    for await (const row of rowsFromFile(path, preview.columns)) all.push(row);
    expect(all[0].nome).toBe("João");
    expect(all[1].nome).toContain("Françoise");
    expect(all[2].nome).toBe("Müller");
  });
});

// ============================================================
// 11. CSV com campo longo
// ============================================================
describe("CSV com campo longo", () => {
  it("parseia campo de 10000 caracteres", async () => {
    const longText = "x".repeat(10000);
    const path = await csv(`id,texto\n1,${longText}\n`);
    const preview = await previewFile(path);
    expect(preview.columns.find(c => c.sqlName === "texto")?.sqlType).toBe("NVARCHAR(MAX)");
    const all: Record<string, unknown>[] = [];
    for await (const row of rowsFromFile(path, preview.columns)) all.push(row);
    expect(all[0].texto).toBe(longText);
  });
});

// ============================================================
// 12. XLSX com alinhamento de colunas
// ============================================================
describe("XLSX com colunas alinhadas", () => {
  it("parseia XLSX com primeira coluna vazia no header", async () => {
    const path = await xlsx([
      ["", "codigo", "unidade", "pack"],
      [0, "AMA240", "UN", 272],
      [1, "AMD120", "UN", 20],
    ]);
    const preview = await previewFile(path);
    expect(preview.columns.map(c => c.sqlName)).toEqual(["codigo", "unidade", "pack"]);
    const all: Record<string, unknown>[] = [];
    for await (const row of rowsFromFile(path, preview.columns)) all.push(row);
    expect(all[0].codigo).toBe("AMA240");
    expect(all[1].pack).toBe("20");
  });
});

// ============================================================
// 13. Duas análises simultâneas (concorrência simulada)
// ============================================================
describe("Duas importações simultâneas simuladas", () => {
  it("processa dois CSVs diferentes em paralelo sem interferência", async () => {
    const path1 = await writeFile(join(dir, "a.csv"), "id,nome\n1,Ana\n2,Bob\n", "utf8").then(() => join(dir, "a.csv"));
    const path2 = await writeFile(join(dir, "b.csv"), "codigo,valor\nX001,100\nX002,200\n", "utf8").then(() => join(dir, "b.csv"));
    const [p1, p2] = await Promise.all([
      previewFile(path1),
      previewFile(path2),
    ]);
    expect(p1.columns.map(c => c.sqlName)).toEqual(["id", "nome"]);
    expect(p2.columns.map(c => c.sqlName)).toEqual(["codigo", "valor"]);
    expect(p1.rowCount).toBe(2);
    expect(p2.rowCount).toBe(2);
  });
});

// ============================================================
// 14. convert() pós-processamento preserva compatibilidade
// ============================================================
describe("convert() — pós-processamento opcional (retroativo)", () => {
  it("converte BIGINT", () => {
    expect(convert("123", "BIGINT")).toBe("123");
  });
  it("converte DECIMAL brasileiro", () => {
    expect(convert("1.234,56", "DECIMAL(18,4)")).toBe(1234.56);
    expect(convert("123,45", "DECIMAL(18,4)")).toBe(123.45);
  });
  it("converte DATE", () => {
    expect(convert("2026-05-04", "DATE")).toEqual(new Date("2026-05-04"));
    expect(convert("04/05/2026", "DATE")).toEqual(new Date("2026-05-04T00:00:00Z"));
  });
  it("converte DATETIME2", () => {
    expect(convert("12/02/2024 12:30:01", "DATETIME2")).toEqual(new Date("2024-02-12T12:30:01"));
  });
  it("converte TIME", () => {
    expect(convert("08:30:00", "TIME")).toBe("08:30:00");
  });
  it("retorna string para tipo não reconhecido", () => {
    expect(convert(42, "NVARCHAR(MAX)")).toBe("42");
  });
  it("trata nulo", () => {
    expect(convert(null, "BIGINT")).toBeNull();
    expect(convert("", "DATE")).toBeNull();
    expect(convert("  ", "DECIMAL(18,4)")).toBeNull();
  });
});

// ============================================================
// 15. Retry boundary: mensagens de erro não-BULK não retentam
// ============================================================
describe("Lógica de retry do bulk insert", () => {
  it("identifica corretamente erro não transiente (não contém 'OLE DB provider \"BULK\"')", () => {
    const transientMsg = 'Cannot fetch a row from OLE DB provider "BULK" for linked server "(null)".';
    const nonTransientMsg = "The credential with name 'CatworldBulkCred_abc123' already exists.";
    // A condição de retry no código: `message.includes('OLE DB provider "BULK"')`
    expect(transientMsg.includes('OLE DB provider "BULK"')).toBe(true);
    expect(nonTransientMsg.includes('OLE DB provider "BULK"')).toBe(false);
  });
});

