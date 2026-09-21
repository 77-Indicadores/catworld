// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewFile, rowsFromFile, type ParseStats } from "./parser";

const dir = mkdtempSync(join(tmpdir(), "cw-1col-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function load(name: string, content: string) {
  const p = join(dir, name);
  writeFileSync(p, content);
  const prev = await previewFile(p);
  const stats: ParseStats = {};
  const rows: Record<string, unknown>[] = [];
  for await (const r of rowsFromFile(p, prev.columns, { encoding: prev.encoding, separator: prev.separator ?? "," }, stats)) rows.push(r);
  return { prev, rows, stats };
}

describe("CSV de UMA coluna: linha em branco nao e registro", () => {
  it("linhas em branco no meio e no fim NAO viram linhas NULL (preview e import concordam)", async () => {
    const { prev, rows, stats } = await load("a.csv", "nome\nana\n\nbia\n\n\ncarla\n\n");
    expect(prev.rowCount).toBe(3);
    expect(rows.map((r) => r.nome)).toEqual(["ana", "bia", "carla"]);
    expect(stats.fallbackReason).toBe("single-column"); // decidido por arquivo: uma coluna nao usa o DuckDB
  });
  it("com CRLF e sem quebra final", async () => {
    const { rows } = await load("b.csv", "nome\r\nana\r\n\r\nbia");
    expect(rows.map((r) => r.nome)).toEqual(["ana", "bia"]);
  });
  it("valor entre aspas vazio (\"\") e um registro, nao uma linha em branco", async () => {
    const { prev, rows } = await load("c.csv", "nome\nana\n\"\"\nbia\n");
    expect(prev.rowCount).toBe(3);
    expect(rows.length).toBe(3);
  });
  it("uma coluna com virgula/ponto e virgula so dentro de aspas continua uma coluna", async () => {
    const { prev, rows } = await load("d.csv", "texto\n\"a, b\"\n\"c; d\"\n");
    expect(prev.columns.length).toBe(1);
    expect(rows.map((r) => r.texto)).toEqual(["a, b", "c; d"]);
  });
  it("uma coluna, sem linhas em branco: inalterado", async () => {
    const { prev, rows } = await load("e.csv", "id\n1\n2\n3\n");
    expect(prev.rowCount).toBe(3);
    expect(rows.length).toBe(3);
  });
});
