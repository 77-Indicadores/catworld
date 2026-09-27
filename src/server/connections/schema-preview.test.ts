import { describe, expect, it } from "vitest";
import { buildStructuredDiff } from "./schema-preview";
import type { ResolvedColumn } from "./source-values";

const col = (sqlName: string, sqlType: string, extra: Partial<ResolvedColumn> = {}): ResolvedColumn => ({ originalName: sqlName, sqlName, sqlType, nullable: true, ...extra });

describe("buildStructuredDiff", () => {
  it("sem catalogo (fonte nova, nunca comparada): tudo 'new', nao quebra", () => {
    const r = buildStructuredDiff([col("a", "BIGINT"), col("b", "DATE")], undefined);
    expect(r.changed).toBe(false);
    expect(r.hasBreakingChange).toBe(false);
    expect(r.columns.map((c) => c.category)).toEqual(["new", "new"]);
  });

  it("tipo identico: 'unchanged'", () => {
    const r = buildStructuredDiff([col("a", "BIGINT")], [{ sqlName: "a", sqlType: "BIGINT" }]);
    expect(r.hasBreakingChange).toBe(false);
    expect(r.columns).toEqual([{ sqlName: "a", catalogType: "BIGINT", candidateType: "BIGINT", category: "unchanged" }]);
  });

  it("coluna nova na conexao candidata: 'new'", () => {
    const r = buildStructuredDiff([col("a", "BIGINT"), col("b", "DATE")], [{ sqlName: "a", sqlType: "BIGINT" }]);
    const b = r.columns.find((c) => c.sqlName === "b")!;
    expect(b).toEqual({ sqlName: "b", catalogType: null, candidateType: "DATE", category: "new" });
    expect(r.hasBreakingChange).toBe(false);
  });

  it("coluna sumiu na conexao candidata: 'removed' e conta como breaking", () => {
    const r = buildStructuredDiff([col("a", "BIGINT")], [{ sqlName: "a", sqlType: "BIGINT" }, { sqlName: "z", sqlType: "BIGINT" }]);
    const z = r.columns.find((c) => c.sqlName === "z")!;
    expect(z).toEqual({ sqlName: "z", catalogType: "BIGINT", candidateType: null, category: "removed" });
    expect(r.hasBreakingChange).toBe(true);
  });

  it("DECIMAL legado tolerado (mapeamento mais fiel, mesma faixa): 'tolerated', nao breaking", () => {
    const r = buildStructuredDiff([col("preco", "DECIMAL(19,4)")], [{ sqlName: "preco", sqlType: "DECIMAL(18,4)" }]);
    expect(r.columns).toEqual([{ sqlName: "preco", catalogType: "DECIMAL(18,4)", candidateType: "DECIMAL(19,4)", category: "tolerated" }]);
    expect(r.hasBreakingChange).toBe(false);
  });

  it("mudanca estrutural de verdade (familia de tipo mudou): 'structural', breaking", () => {
    const r = buildStructuredDiff([col("valor", "NVARCHAR(MAX)")], [{ sqlName: "valor", sqlType: "DECIMAL(18,4)" }]);
    expect(r.columns).toEqual([{ sqlName: "valor", catalogType: "DECIMAL(18,4)", candidateType: "NVARCHAR(MAX)", category: "structural" }]);
    expect(r.hasBreakingChange).toBe(true);
  });
});
