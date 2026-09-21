import { describe, expect, it } from "vitest";
import { WatermarkTracker, buildDeltaPredicate, compareWatermark, deltaCap, deltaKindOf, isFutureWatermark, lowerBound, normalizeWatermark } from "./source-delta";

describe("marca d'agua", () => {
  it("formato antigo (ISO com Z, ms) e lido e normalizado para UTC com microssegundos", () => {
    expect(normalizeWatermark("2026-01-01T00:00:00.000Z", "temporal")).toBe("2026-01-01 00:00:00.000000");
    expect(normalizeWatermark("lixo", "temporal")).toBeNull();
    expect(normalizeWatermark("42", "integer")).toBe("42");
  });
  it("janela de sobreposicao: limite = marca - N minutos (cruza a meia-noite e preserva microssegundos)", () => {
    expect(lowerBound("2026-01-01 00:05:00.123456", "temporal", 10)).toBe("2025-12-31 23:55:00.123456");
    expect(lowerBound("42", "integer", 10)).toBe("42");
  });
  it("predicado usa >= (empates) e OR IS NULL (delta nulo), por dialeto", () => {
    expect(buildDeltaPredicate({ kind: "temporal", quotedColumn: '"upd"', watermark: "2026-01-01 10:00:00.5", dialect: "postgres", lookbackMinutes: 0 }))
      .toBe(`("upd" >= '2026-01-01 10:00:00.5'::timestamp OR "upd" IS NULL)`);
    expect(buildDeltaPredicate({ kind: "temporal", quotedColumn: "[upd]", watermark: "2026-01-01 10:10:00.000000", dialect: "mssql", lookbackMinutes: 10 }))
      .toBe("([upd] >= CAST('2026-01-01T10:00:00.000000' AS DATETIME2(7)) OR [upd] IS NULL)");
    expect(buildDeltaPredicate({ kind: "integer", quotedColumn: '"id"', watermark: "100", dialect: "postgres" })).toBe('("id" >= 100 OR "id" IS NULL)');
  });
  it("texto escapa aspas", () => {
    expect(buildDeltaPredicate({ kind: "text", quotedColumn: '"v"', watermark: "o'brien", dialect: "postgres", lookbackMinutes: 0 })).toContain("'o''brien'");
  });
  it("valor futuro (2099) nao vira marca: fica no limite do relogio da origem e gera aviso", () => {
    const cap = deltaCap(new Date("2026-06-01T12:00:00Z"), 24)!;
    const t = new WatermarkTracker("temporal", cap);
    for (const v of ["2026-05-31 10:00:00.000000", "2099-12-31 00:00:00.000000", "2026-06-01 11:00:00.000000", null]) t.push(v);
    expect(t.max).toBe("2026-06-01 11:00:00.000000");
    expect(t.futureCount).toBe(1);
    expect(t.nullCount).toBe(1);
    expect(t.warning("upd")).toMatch(/DELTA_FUTURE_VALUES.*2099/);
    expect(isFutureWatermark("2099-12-31 00:00:00.000000", "temporal", cap)).toBe(true);
    expect(isFutureWatermark("2026-06-01 11:00:00.000000", "temporal", cap)).toBe(false);
  });
  it("inteiros comparam como BigInt (nao lexicografico)", () => {
    expect(compareWatermark("9", "10", "integer")).toBe(-1);
    const t = new WatermarkTracker("integer", null);
    ["9", "10", "2"].forEach(v => t.push(v));
    expect(t.max).toBe("10");
    expect(compareWatermark("1.5", "1.25", "decimal")).toBe(1);
  });
  it("tipo da coluna define o tipo de comparacao", () => {
    expect(deltaKindOf("DATETIME2")).toBe("temporal");
    expect(deltaKindOf("BIGINT")).toBe("integer");
    expect(deltaKindOf("DECIMAL(10,2)")).toBe("decimal");
    expect(deltaKindOf("NVARCHAR(MAX)")).toBe("text");
  });
});
