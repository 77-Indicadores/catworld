// @vitest-environment node
/**
 * Confiabilidade da leitura de CSV: NUNCA entregar menos (nem mais) linhas do que o arquivo tem.
 *
 * Bug real (produção): em @duckdb/node-api 1.5.x o stream termina em SILÊNCIO no primeiro chunk com erro. Uma linha com coluna a
 * mais na linha 60.000 de 100.000 devolvia 59.392 linhas, sem erro, e o import ficava COMPLETED (visto: 45.056 de 49.022, todo dia).
 * Aqui cada arquivo malformado é lido pelo parser REAL e comparado com o esperado linha a linha (ids em sequência, sem buracos e
 * sem duplicatas) — o oráculo é o gerador do arquivo, não o próprio parser.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewFile, rowsFromFile } from "./parser";

const dir = mkdtempSync(join(tmpdir(), "cw-reliab-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Opts = { n: number; bad?: Record<number, string>; enc?: BufferEncoding; sep?: string; eol?: string; bom?: boolean; header?: string; row?: (i: number) => string };

/** Gera um CSV com `n` linhas de dados (id 1..n); `bad[i]` substitui a linha i por texto arbitrário (malformado). */
function csv(name: string, o: Opts): string {
  const sep = o.sep ?? ",", eol = o.eol ?? "\n";
  const lines = [o.header ?? ["id", "nome", "valor"].join(sep)];
  for (let i = 1; i <= o.n; i++) lines.push(o.bad?.[i] ?? (o.row ? o.row(i) : [i, `nome ${i}`, `${i}.5`].join(sep)));
  const p = join(dir, name);
  writeFileSync(p, (o.bom ? "﻿" : "") + lines.join(eol) + eol, o.enc ?? "utf8");
  return p;
}

async function read(path: string) {
  const prev = await previewFile(path);
  const rows: Record<string, unknown>[] = [];
  for await (const r of rowsFromFile(path, prev.columns, { encoding: prev.encoding, separator: prev.separator ?? ",", ext: ".csv" })) rows.push(r);
  return { prev, rows };
}

/** ids entregues == 1..n, cada um uma vez, na ordem. */
function expectExactly(rows: Record<string, unknown>[], n: number, idKey = "id") {
  expect(rows.length).toBe(n);
  const ids = rows.map((r) => Number(r[idKey]));
  expect(new Set(ids).size).toBe(n);                       // sem duplicata
  for (let i = 0; i < n; i++) if (ids[i] !== i + 1) throw new Error(`posição ${i}: esperado id ${i + 1}, veio ${ids[i]}`); // sem buraco/ordem trocada
}

describe("CSV bem formado: exatamente as linhas do arquivo", () => {
  // fronteiras dos chunks do DuckDB (2048) e do lote de import (1024)
  for (const n of [1, 2, 1023, 1024, 1025, 2047, 2048, 2049, 4096, 4097, 10_000]) {
    it(`${n} linhas`, async () => {
      const { prev, rows } = await read(csv(`ok-${n}.csv`, { n }));
      expect(prev.rowCount).toBe(n);
      expectExactly(rows, n);
    });
  }
  it("só cabeçalho: zero linhas", async () => {
    const { rows } = await read(csv("hdr.csv", { n: 0 }));
    expect(rows).toEqual([]);
  });
  it("CRLF, BOM e ponto e vírgula", async () => {
    const { rows } = await read(csv("crlf.csv", { n: 3000, eol: "\r\n", bom: true, sep: ";" }));
    expectExactly(rows, 3000);
  });
  it("campo com quebra de linha e aspas duplicadas dentro de aspas, atravessando chunks", async () => {
    const { rows } = await read(csv("multi.csv", { n: 6000, row: (i) => `${i},"linha1\nlinha2 ""citada"" ${i}",${i}.5` }));
    expectExactly(rows, 6000);
    expect(rows[5]!.nome).toBe('linha1\nlinha2 "citada" 6');
  });
  it("acentos e emoji em UTF-8", async () => {
    const { rows } = await read(csv("utf.csv", { n: 2500, row: (i) => `${i},ção ${i} ✓ 日本,${i}.5` }));
    expectExactly(rows, 2500);
    expect(rows[0]!.nome).toBe("ção 1 ✓ 日本");
  });
  it("Windows-1252 (caminho do arquivo transcodificado)", async () => {
    const { rows } = await read(csv("w1252.csv", { n: 5000, enc: "latin1", row: (i) => `${i},maçã ${i},${i}.5` }));
    expectExactly(rows, 5000);
    expect(rows[0]!.nome).toBe("maçã 1");
  });
});

describe("CSV malformado: nada some em silêncio (o bug real)", () => {
  // TIP-07: campos a MAIS que o cabeçalho perderiam valores: o import é RECUSADO nomeando a linha (antes entregava as linhas com
  // as células extras perdidas em silêncio). Linha do arquivo = índice do dado + 1 (cabeçalho é a linha 1).
  const tooMany: [string, Opts, number][] = [
    ["coluna a MAIS no meio (linha 60.000 de 100.000)", { n: 100_000, bad: { 60_000: "60000,nome,1,SOBRA,MAIS" } }, 60_001],
    ["coluna a MAIS logo após o 1º chunk (linha 2.049)", { n: 5000, bad: { 2049: "2049,nome,1,SOBRA" } }, 2050],
    ["coluna a MAIS na última linha", { n: 5000, bad: { 5000: "5000,nome,1,SOBRA" } }, 5001],
    ["várias linhas com coluna a mais espalhadas", { n: 20_000, bad: { 3000: "3000,a,1,X", 9000: "9000,a,1,X,Y", 15_000: "15000,a,1,X" } }, 3001],
  ];
  for (const [label, o, line] of tooMany) {
    for (const enc of ["utf8", "latin1"] as const) {
      it(`${label} — ${enc}: erro alto nomeando a linha ${line}`, async () => {
        await expect(read(csv(`extra-${enc}-${label.length}.csv`, { ...o, enc }))).rejects.toThrow(new RegExp(`Linha ${line} `));
      });
    }
  }
  it("campos extras VAZIOS no fim (vírgula sobrando) não perdem nada e são aceitos", async () => {
    const { rows } = await read(csv("trailing.csv", { n: 3000, bad: { 1500: "1500,nome,1,,", 2: "2,nome,1,\"\"" } }));
    expectExactly(rows, 3000);
  });

  const cases: [string, Opts][] = [
    ["coluna a MENOS", { n: 100_000, bad: { 60_000: "60000,so" } }],
    ["aspas no meio de um campo", { n: 100_000, bad: { 60_000: '60000,nome "x" y,5' } }],
  ];
  for (const [label, o] of cases) {
    it(label, async () => {
      const { prev, rows } = await read(csv(`bad-${label.length}.csv`, o));
      expectExactly(rows, o.n);
      expect(prev.rowCount).toBe(o.n);
    }, 30_000);
    it(`${label} — arquivo Windows-1252`, async () => {
      const { rows } = await read(csv(`bad-w-${label.length}.csv`, { ...o, enc: "latin1" }));
      expectExactly(rows, o.n);
    }, 30_000);
  }
  it("linha em branco no meio não vira linha nem derruba o resto", async () => {
    const p = csv("blank.csv", { n: 10_000, bad: { 5000: "" } });
    const { rows } = await read(p);
    expect(rows.length).toBe(9999);
    const ids = rows.map((r) => Number(r.id));
    expect(ids).not.toContain(5000);
    expect(new Set(ids).size).toBe(9999);
  });
  it("aspas abertas e nunca fechadas: erro ALTO (nunca importa em silêncio um pedaço)", async () => {
    const p = csv("unclosed.csv", { n: 5000, bad: { 2500: '2500,"aberta,5' } });
    await expect(read(p)).rejects.toThrow();
  });
});
