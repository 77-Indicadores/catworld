// @vitest-environment node
/**
 * Encoding e dialeto de CSV (TIP-03/04/07/17/18): o que o preview vê é exatamente o que o import lê; nada é decodificado com "�" em silêncio.
 * Oráculo: o texto que escrevemos no arquivo.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import { previewFile, rowsFromFile } from "./parser";

const dir = mkdtempSync(join(tmpdir(), "cw-dialect-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let seq = 0;

function put(content: string | Buffer): string {
  const p = join(dir, `f${seq++}.csv`);
  writeFileSync(p, content);
  return p;
}
async function read(path: string) {
  const prev = await previewFile(path);
  const rows: Record<string, unknown>[] = [];
  for await (const r of rowsFromFile(path, prev.columns, { encoding: prev.encoding, separator: prev.separator ?? ",", ext: ".csv" })) rows.push(r);
  return { prev, rows };
}

describe("TIP-03: encoding decidido pelo arquivo inteiro", () => {
  it("UTF-8 válido com caractere multibyte cruzando o byte 65.536 (antes: mojibake win1252)", async () => {
    const head = "id,nome\n";
    const filler = "1,x\n".repeat(Math.floor((65535 - head.length) / 4));
    const pad = "y".repeat(65535 - head.length - filler.length); // o "ç" começa exatamente no byte 65.535
    const body = head + filler + "9," + pad.slice(2) + "ção\n";
    const buf = Buffer.from(body, "utf8");
    const at = buf.indexOf(Buffer.from("ç"));
    expect(at).toBeGreaterThan(65000);
    const { prev, rows } = await read(put(buf));
    expect(prev.encoding).toBe("utf8");
    expect(String(rows[rows.length - 1]!.nome)).toMatch(/ção$/);
  });
  it("Windows-1252 que só aparece depois de 64 KB (antes: U+FFFD gravado no dado)", async () => {
    const ascii = "1,x\n".repeat(20_000);              // 80 KB de ASCII
    const buf = Buffer.concat([Buffer.from("id,nome\n" + ascii), iconv.encode("2,maçã\n", "win1252")]);
    const { prev, rows } = await read(put(buf));
    expect(prev.encoding).toBe("win1252");
    expect(rows[rows.length - 1]!.nome).toBe("maçã");
    expect(rows.some((r) => String(r.nome).includes("�"))).toBe(false);
  });
  it("byte inválido para Windows-1252 (0x81) é ERRO, não U+FFFD", async () => {
    const buf = Buffer.concat([Buffer.from("id,nome\n1,a"), Buffer.from([0x81]), Buffer.from("b\n2,\xe7\n", "latin1")]);
    await expect(read(put(buf))).rejects.toThrow(/Windows-1252/);
  });
  it("UTF-8 com BOM: BOM não vira parte do nome da coluna", async () => {
    const { prev } = await read(put("﻿id,nome\n1,a\n"));
    expect(prev.columns.map((c) => c.originalName)).toEqual(["id", "nome"]);
  });
});

describe("TIP-17: UTF-16", () => {
  const text = "id;nome;valor\n1;ação ✓;1,5\n2;maçã;2,5\n";
  for (const [label, buf] of [
    ["LE com BOM", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")])],
    ["BE com BOM", Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()])],
    ["LE sem BOM", Buffer.from(text, "utf16le")],
    ["BE sem BOM", Buffer.from(text, "utf16le").swap16()],
  ] as const) {
    it(`UTF-16 ${label}: preview e carga leem os mesmos valores`, async () => {
      const { prev, rows } = await read(put(buf));
      expect(prev.encoding).toMatch(/^utf16/);
      expect(prev.rowCount).toBe(2);
      expect(prev.columns.map((c) => c.originalName)).toEqual(["id", "nome", "valor"]);
      expect(rows.map((r) => r.nome)).toEqual(["ação ✓", "maçã"]);
      expect(rows.map((r) => r.valor)).toEqual(["1,5", "2,5"]);
    });
  }
  it("UTF-16 truncado (byte sobrando) é erro", async () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le"), Buffer.from([0x41])]);
    await expect(read(put(buf))).rejects.toThrow(/UTF-16/);
  });
});

describe("TIP-04: o DuckDB lê com o dialeto do preview", () => {
  it("cabeçalho numérico não vira dado (antes: DuckDB decidia 'sem cabeçalho')", async () => {
    const { prev, rows } = await read(put("2020,2021,2022\n1,2,3\n4,5,6\n"));
    expect(prev.columns.map((c) => c.originalName)).toEqual(["2020", "2021", "2022"]);
    expect(rows.length).toBe(2);
    expect(Object.values(rows[0]!)).toEqual(["1", "2", "3"]);
  });
  it("aspas simples ficam no valor", async () => {
    const { rows } = await read(put("id,nome\n1,'abc'\n2,'it''s'\n"));
    expect(rows[0]!.nome).toBe("'abc'");
  });
  it("cabeçalho com coluna vazia e repetida: nenhuma coluna some", async () => {
    const { prev, rows } = await read(put("a,,a\n1,2,3\n4,5,6\n"));
    expect(prev.columns.length).toBe(3);
    expect(rows.map((r) => Object.values(r))).toEqual([["1", "2", "3"], ["4", "5", "6"]]);
  });
  it("separador | é reconhecido", async () => {
    const { prev, rows } = await read(put("id|nome\n1|ana\n2|bia\n"));
    expect(prev.separator).toBe("|");
    expect(rows.map((r) => r.nome)).toEqual(["ana", "bia"]);
  });
  it("tabulação e ponto e vírgula continuam funcionando", async () => {
    expect((await read(put("id\tnome\n1\tana\n"))).prev.separator).toBe("\t");
    const s = await read(put("id;valor\n1;1,5\n2;2,5\n"));
    expect(s.prev.separator).toBe(";");
    expect(s.rows.map((r) => r.valor)).toEqual(["1,5", "2,5"]);
  });
  it("vírgula dentro de aspas não decide o separador", async () => {
    const { prev } = await read(put('id;nome\n1;"a,b,c,d"\n2;"e,f,g"\n'));
    expect(prev.separator).toBe(";");
  });
  it("empate entre separadores é ERRO (não adivinha)", async () => {
    await expect(previewFile(put("a,b;c\n1,2;3\n4,5;6\n"))).rejects.toThrow(/ambíguo/);
  });
  it("uma coluna só (sem separador) continua válido", async () => {
    const { prev, rows } = await read(put("nome\nana\nbia\n"));
    expect(prev.columns.length).toBe(1);
    expect(rows.map((r) => r.nome)).toEqual(["ana", "bia"]);
  });
});

describe("caminho rápido", () => {
  it("DuckDB (dialeto explícito) é usado em UTF-8, UTF-16 e Windows-1252, e não em fim de linha misto", async () => {
    const t = "id;nome\n1;a\n2;b\n";
    const cases: [string, Buffer, string][] = [
      ["utf8", Buffer.from(t), "duckdb"],
      ["utf16", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(t, "utf16le")]), "duckdb"],
      ["win1252", iconv.encode("id;nome\n1;ç\n", "win1252"), "duckdb"],
      ["sep=", Buffer.from("sep=;\n" + t), "duckdb"],
      ["eol misto", Buffer.from("id;nome\r\n1;a\n"), "csv-parse"],
    ];
    for (const [label, buf, method] of cases) {
      const p = put(buf);
      const prev = await previewFile(p);
      const stats: import("./parser").ParseStats = {};
      const rows: unknown[] = [];
      for await (const r of rowsFromFile(p, prev.columns, { ext: ".csv" }, stats)) rows.push(r);
      expect([label, stats.parseMethod]).toEqual([label, method]);
      expect(rows.length).toBe(prev.rowCount);
    }
  });
});

describe("TIP-18: linha sep= e preâmbulo", () => {
  it("'sep=;' na 1ª linha é usada e pulada: preview e carga", async () => {
    const { prev, rows } = await read(put("sep=;\nid;nome\n1;a\n2;b\n"));
    expect(prev.columns.map((c) => c.originalName)).toEqual(["id", "nome"]);
    expect(prev.rowCount).toBe(2);
    expect(rows.map((r) => r.nome)).toEqual(["a", "b"]);
  });
  it("título acima do cabeçalho é ERRO (não vira cabeçalho nem dado)", async () => {
    await expect(previewFile(put("Relatório de vendas\nid;nome\n1;a\n2;b\n3;c\n"))).rejects.toThrow(/preâmbulo/);
  });
});

describe("TIP-07: fim de linha misto e campos a mais", () => {
  it("CRLF, LF e CR no mesmo arquivo: 3 registros (antes: fundidos)", async () => {
    const { prev, rows } = await read(put("id,nome\r\n1,a\n2,b\r\n3,c\n"));
    expect(prev.rowCount).toBe(3);
    expect(rows.map((r) => [r.id, r.nome])).toEqual([["1", "a"], ["2", "b"], ["3", "c"]]);
  });
  it("célula com quebra de linha dentro de aspas em arquivo CRLF continua uma célula", async () => {
    const { rows } = await read(put('id,nome\r\n1,"a\nb"\r\n2,c\r\n'));
    expect(rows.map((r) => r.nome)).toEqual(["a\nb", "c"]);
  });
  it("linha com campo extra: erro nomeando a linha, tanto no preview quanto na carga", async () => {
    const p = put("id,nome\n1,a\n2,b,EXTRA\n3,c\n");
    await expect(previewFile(p)).rejects.toThrow(/Linha 3 /);
  });
});
