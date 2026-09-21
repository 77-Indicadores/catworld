import { describe, expect, it } from "vitest";
import { isStagingPartial, stagingHoldsWholeFile } from "./staging-guard";

const base = { knownRowCount: 828_672, targetExists: true, phase2: false };

describe("isStagingPartial", () => {
  it("replace por diferença (tabela com _cw_rh, ex.: vendas_completo): 50 mil de 828 mil é parcial → recarrega", () => {
    expect(isStagingPartial({ ...base, mode: "replace", stagingRowCount: 50_000 })).toBe(true);
    expect(isStagingPartial({ ...base, mode: "replace", stagingRowCount: 650_000 })).toBe(true);
  });
  it("staging completo não é parcial (retry idempotente legítimo continua pulando a carga)", () => {
    expect(isStagingPartial({ ...base, mode: "replace", stagingRowCount: 828_672 })).toBe(false);
  });
  it("staging vazio não é parcial (nada a descartar)", () => {
    expect(isStagingPartial({ ...base, mode: "replace", stagingRowCount: 0 })).toBe(false);
  });
  it("sem contagem conhecida do arquivo não dá para afirmar: não descarta", () => {
    expect(isStagingPartial({ ...base, mode: "replace", knownRowCount: 0, stagingRowCount: 10 })).toBe(false);
  });
  it("phase2 (SDK mandou só a diferença): o staging tem menos linhas que o arquivo de propósito → nunca parcial", () => {
    expect(isStagingPartial({ ...base, mode: "replace", phase2: true, stagingRowCount: 10 })).toBe(false);
  });
  it("append/upsert também: staging parcial seria mesclado/acrescentado e perderia linhas em silêncio", () => {
    expect(isStagingPartial({ ...base, mode: "append", stagingRowCount: 10 })).toBe(true);
    expect(isStagingPartial({ ...base, mode: "upsert", stagingRowCount: 10 })).toBe(true);
    expect(isStagingPartial({ ...base, mode: "upsert", stagingRowCount: 828_672 })).toBe(false);
  });
  it("tabela nova (mesmo em append): o staging é o arquivo inteiro", () => {
    expect(isStagingPartial({ ...base, mode: "append", targetExists: false, stagingRowCount: 10 })).toBe(true);
  });
});

describe("stagingHoldsWholeFile", () => {
  it("todo modo, menos phase2", () => {
    expect(stagingHoldsWholeFile({ mode: "replace", targetExists: true, phase2: true })).toBe(false);
    for (const mode of ["replace", "append", "upsert"]) for (const targetExists of [true, false])
      expect(stagingHoldsWholeFile({ mode, targetExists, phase2: false })).toBe(true);
  });
});
