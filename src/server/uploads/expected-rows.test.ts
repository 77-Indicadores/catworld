import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveExpectedRows, stripServerMark } from "./expected-rows";
import { evaluateLoad } from "@/server/integrity/policy";

describe("resolveExpectedRows: so a contagem do servidor e prova", () => {
  it("preview do servidor vale; o valor do cliente que diverge e registrado, nao usado", async () => {
    const r = await resolveExpectedRows({ rowCount: 1000n, previewJson: JSON.stringify({ rowCount: 900, source: "server" }) }, "/x.csv", vi.fn());
    expect(r).toMatchObject({ expected: 900, source: "server-preview", clientRowCount: 1000, clientDisagrees: true });
  });
  it("preview do cliente (sem source) NAO vale: o servidor conta o arquivo", async () => {
    const count = vi.fn().mockResolvedValue(700);
    const r = await resolveExpectedRows({ rowCount: 5000n, previewJson: JSON.stringify({ rowCount: 5000 }) }, "/x.csv", count);
    expect(count).toHaveBeenCalled();
    expect(r).toMatchObject({ expected: 700, source: "server-count", clientDisagrees: true });
  });
  it("contagem indisponivel (stream ou erro): nao usa o numero do cliente", async () => {
    const stream = await resolveExpectedRows({ rowCount: 5000n, previewJson: null }, {} as NodeJS.ReadableStream, vi.fn());
    expect(stream).toMatchObject({ expected: 0, source: "unavailable" });
    const failing = await resolveExpectedRows({ rowCount: 5000n, previewJson: null }, "/x.csv", vi.fn().mockRejectedValue(new Error("x")));
    expect(failing).toMatchObject({ expected: 0, source: "unavailable" });
  });
  it("contagem real de um CSV (cabecalho fora, linha vazia fora)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "er-"));
    try {
      const p = join(dir, "a.csv"); writeFileSync(p, "a,b\n1,x\n\n2,y\n3,z\n");
      const r = await resolveExpectedRows({ rowCount: 99n, previewJson: null }, p);
      expect(r).toMatchObject({ expected: 3, source: "server-count", clientDisagrees: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("stripServerMark", () => {
  it("cliente nao consegue se passar por preview do servidor", () => {
    expect(JSON.parse(stripServerMark(JSON.stringify({ rowCount: 5, source: "server" })))).toEqual({ rowCount: 5 });
    expect(stripServerMark("nao e json")).toBe("nao e json");
  });
});

describe("gate: contagem nao verificada marca SUSPECT (nao bloqueia, nao usa o cliente)", () => {
  it("expectedUnverified gera EXPECTED_UNVERIFIED nao bloqueante", () => {
    const e = evaluateLoad({ kind: "upload", fullState: true, expectedRows: 0, parsedRows: 10, stagedRows: 10, prevRows: 0, expectedUnverified: true });
    expect(e.verdict).toBe("SUSPECT");
    expect(e.reasons.map((x) => [x.code, x.blocking])).toEqual([["EXPECTED_UNVERIFIED", false]]);
  });
  it("divergencia cliente x servidor tambem marca SUSPECT", () => {
    const e = evaluateLoad({ kind: "upload", fullState: true, expectedRows: 10, parsedRows: 10, stagedRows: 10, prevRows: 0, clientCountDisagrees: true });
    expect(e.reasons.map((x) => [x.code, x.blocking])).toEqual([["CLIENT_COUNT_MISMATCH", false]]);
  });
});
