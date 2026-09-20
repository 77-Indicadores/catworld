import { describe, expect, it } from "vitest";
import { getArticle } from "@/lib/knowledge";
import { translateTsql } from "@/server/sql-contract/translate";

// O guia promete que os exemplos funcionam e que os "Não funciona" são recusados: se o motor mudar, este teste avisa.
const codes = (getArticle("linguagem-sql")?.sections ?? []).flatMap((s) => (s.kind === "code" ? [s] : []));

describe("guia da linguagem SQL (base de conhecimento)", () => {
  it("existe e tem exemplos", () => {
    expect(getArticle("linguagem-sql")).not.toBeNull();
    expect(codes.length).toBeGreaterThan(8);
  });
  for (const c of codes.filter((x) => /^(Exemplo|Alternativa)/.test(x.label ?? ""))) {
    it(`traduz para Postgres: ${c.label}`, () => {
      expect(() => translateTsql(c.value, "postgres")).not.toThrow();
    });
  }
  for (const c of codes.filter((x) => /^Não funciona/.test(x.label ?? ""))) {
    it(`é recusado: ${c.label}`, () => {
      expect(() => translateTsql(c.value, "postgres")).toThrow();
    });
  }
});
