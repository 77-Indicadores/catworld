import { describe, expect, it } from "vitest";
import { pgTruncatedIdentifiers } from "./naming";

// Caso real (LITORAL-CLEAN, tabela sales): colunas do SQL Server com > 63 caracteres e o mesmo comeco
const base = "products_product_fiscal_settings_tax_fiscal_scenario_settings_a";
const longA = `${base}ctive_one`;
const longB = `${base}nother_one`;

describe("pgTruncatedIdentifiers (migracao SQL Server -> Postgres)", () => {
  it("nome longo vira os primeiros 63 (o corte do proprio Postgres); colisao ganha _2", () => {
    const out = pgTruncatedIdentifiers(["id", longA, longB]);
    expect(out[0]).toBe("id");
    expect(out[1]).toBe(base);
    expect(out[1]).toHaveLength(63);
    expect(out[2]).toBe(`${base.slice(0, 61)}_2`);
    expect(new Set(out).size).toBe(3);
    expect(out.every((n) => n.length <= 63)).toBe(true);
  });

  it("nomes curtos nunca mudam, mesmo quando um longo cortado bateria com eles", () => {
    expect(pgTruncatedIdentifiers([longA, base])).toEqual([`${base.slice(0, 61)}_2`, base]);
  });

  it("deterministico e sem efeito quando tudo cabe", () => {
    const names = ["a", "b_c", "x".repeat(63)];
    expect(pgTruncatedIdentifiers(names)).toEqual(names);
    expect(pgTruncatedIdentifiers(["id", longA, longB])).toEqual(pgTruncatedIdentifiers(["id", longA, longB]));
  });
});
