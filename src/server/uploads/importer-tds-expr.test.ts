// @vitest-environment node
/** Expressões T-SQL do fallback (staging NVARCHAR(MAX)) do importer SQL Server: só texto gerado; a execução exige SQL Server real. */
import { describe, expect, it } from "vitest";
import { typedSelectExpr } from "./importer";
import type { ParsedColumn } from "./parser";

const col = (sqlType: string, extra: Partial<ParsedColumn> = {}): ParsedColumn => ({ originalName: "v", sqlName: "v", sqlType, nullable: true, ...extra });

describe("typedSelectExpr (fallback com TRY_CONVERT)", () => {
  it("DECIMAL usa o (p,s) da coluna, não (18,4) fixo", () => {
    expect(typedSelectExpr(col("DECIMAL(20,6)", { decimalSep: "." }), "s")).toContain("TRY_CONVERT(DECIMAL(20,6)");
    expect(typedSelectExpr(col("DECIMAL(38,10)", { decimalSep: "." }), "s")).toContain("DECIMAL(38,10)");
  });
  it("DECIMAL: a convenção da coluna decide (ponto decimal remove vírgulas; vírgula decimal remove pontos)", () => {
    const us = typedSelectExpr(col("DECIMAL(18,4)", { decimalSep: "." }), "s");
    expect(us).toContain("REPLACE(NULLIF(LTRIM(RTRIM(s.[v])),''),',','')");
    expect(us).not.toContain("LIKE");
    const br = typedSelectExpr(col("DECIMAL(18,4)", { decimalSep: "," }), "s");
    expect(br).toContain("REPLACE(REPLACE(");
    expect(br).not.toContain("LIKE");
  });
  it("DECIMAL sem convenção (mapeamento antigo): critério legado preservado", () => {
    expect(typedSelectExpr(col("DECIMAL(18,4)"), "s")).toContain("LIKE '%,%'");
  });
  it("DATE dd/mm: só o estilo 103 (nunca 101 por valor)", () => {
    const e = typedSelectExpr(col("DATE", { dateOrder: "dmy" }), "s");
    expect(e).toContain(",103)");
    expect(e).not.toContain(",101)");
  });
  it("DATE mm/dd: só o estilo 101", () => {
    const e = typedSelectExpr(col("DATETIME2", { dateOrder: "mdy" }), "s");
    expect(e).toContain(",101)");
    expect(e).not.toContain(",103)");
  });
  it("DATE sem convenção (mapeamento antigo): legado com os dois", () => {
    const e = typedSelectExpr(col("DATE"), "s");
    expect(e).toContain(",103)");
    expect(e).toContain(",101)");
  });
});
