import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { previewFile, rowsFromFile } from "./parser";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "catworld-parser-test-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function csv(content: string) {
  const path = join(dir, "sample.csv");
  await writeFile(path, content, "utf8");
  return path;
}

describe("inferência de schema escaneia o arquivo inteiro, não só a amostra", () => {
  it("marca nullable quando uma linha além da amostra de 20 vem curta (campo ausente)", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => i === 22 ? "1,Nome" : `${i + 1},Nome,Valor`).join("\n");
    const path = await csv(`id,nome,extra\n${rows}\n`);
    const preview = await previewFile(path);
    expect(preview.columns.find((c) => c.sqlName === "extra")?.nullable).toBe(true);
    const all = [];
    for await (const row of rowsFromFile(path, preview.columns)) all.push(row);
    expect(all[22].extra).toBeNull();
  });

  it("calcula o tamanho máximo da coluna olhando linhas além das primeiras 20", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => i === 23 ? `${i + 1},${"x".repeat(500)}` : `${i + 1},curto`).join("\n");
    const path = await csv(`id,texto\n${rows}\n`);
    const preview = await previewFile(path);
    const col = preview.columns.find((c) => c.sqlName === "texto");
    expect(col?.sqlType).toBe("NVARCHAR(500)");
  });

  it("trata campo só com espaço em branco como nulo", async () => {
    const path = await csv(`id,nome\n1, \n2,Ana\n`);
    const preview = await previewFile(path);
    expect(preview.columns.find((c) => c.sqlName === "nome")?.nullable).toBe(true);
  });

  it("tolera aspas soltas no meio do valor (CSV mal-formatado)", async () => {
    const path = await csv(`id,descricao\n1,PAPEL SULFITE 61 X 50 75GR 2"\n2,Normal\n`);
    const preview = await previewFile(path);
    expect(preview.columns).toHaveLength(2);
    expect(preview.rows[0].descricao).toContain('2"');
  });

  it("infere BIGINT, DECIMAL (BR e internacional) e DATE corretamente", async () => {
    const path = await csv(`inteiro;decimal_br;decimal_us;data\n10;1.234,56;123.45;2026-05-04\n20;2.345,67;67.89;2026-05-05\n`);
    const preview = await previewFile(path);
    const type = (name: string) => preview.columns.find((c) => c.sqlName === name)?.sqlType;
    expect(type("inteiro")).toBe("BIGINT");
    expect(type("decimal_br")).toBe("DECIMAL(18,4)");
    expect(type("decimal_us")).toBe("DECIMAL(18,4)");
    expect(type("data")).toBe("DATE");
  });
});
