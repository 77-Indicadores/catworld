// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewFile, rowsFromFile } from "./parser";
import { firstUnclosedQuoteLine } from "./csv-detect";

const dir = mkdtempSync(join(tmpdir(), "cw-quote-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const lines = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `${from + i},nome ${from + i},${from + i}.5`);

describe("firstUnclosedQuoteLine (maquina de estados)", () => {
  it("casos", () => {
    const f = (t: string, sep = ",") => firstUnclosedQuoteLine(t, sep);
    expect(f('a,b\n1,"x\n2,y\n')).toBe(2);
    expect(f('a,b\n1,"x"\n2,y\n')).toBeNull();
    expect(f('a,b\n1,"linha1\nlinha2"\n')).toBeNull();
    expect(f('a,b\n1,"diz ""oi"""\n2,z\n')).toBeNull();
    expect(f('a,b\n1,tela 5" hd\n')).toBeNull();          // aspa no meio de valor sem aspas
    expect(f('a;b\r\n1;"x\r\n2;y\r\n', ";")).toBe(2);      // CRLF
    expect(f('a,b\r1,"x\r2,y\r')).toBe(2);                 // so CR
    expect(f('a,b\n1,"x"')).toBeNull();                    // fecha na ultima posicao do arquivo
  });
});

describe("aspa nao fechada: o arquivo inteiro nao pode virar um campo so em silencio", () => {
  it("preview recusa e nomeia a linha onde a aspa abriu", async () => {
    const p = join(dir, "q1.csv");
    writeFileSync(p, ["id,nome,valor", ...lines(4), '5,"Maria da Silva,5.5', ...lines(30, 6)].join("\n") + "\n");
    await expect(previewFile(p)).rejects.toThrow(/linha 6/i);
    await expect(previewFile(p)).rejects.toThrow(/nunca foram fechadas/i);
  });
  it("import (rowsFromFile) tambem recusa, sem entregar linhas", async () => {
    const p = join(dir, "q2.csv");
    writeFileSync(p, ["id,nome,valor", ...lines(4), '5,"Maria da Silva,5.5', ...lines(30, 6)].join("\n") + "\n");
    const got: unknown[] = [];
    const cols = [{ originalName: "id", sqlName: "id", sqlType: "NVARCHAR(MAX)", nullable: true }, { originalName: "nome", sqlName: "nome", sqlType: "NVARCHAR(MAX)", nullable: true }, { originalName: "valor", sqlName: "valor", sqlType: "NVARCHAR(MAX)", nullable: true }];
    await expect((async () => { for await (const r of rowsFromFile(p, cols, {})) got.push(r); })()).rejects.toThrow(/aspas/i);
  });
  it("aspas fechadas com quebra de linha dentro continuam validas", async () => {
    const p = join(dir, "q3.csv");
    writeFileSync(p, 'id,nome\n1,"linha1\nlinha2"\n2,"ok"\n');
    const prev = await previewFile(p);
    expect(prev.rowCount).toBe(2);
  });
  it("aspa no meio de um valor sem aspas (5\" de tela) nao e recusada", async () => {
    const p = join(dir, "q4.csv");
    writeFileSync(p, 'id,nome\n1,tela 5" hd\n2,outra\n');
    expect((await previewFile(p)).rowCount).toBe(2);
  });
});
