import { describe, expect, it } from "vitest";
import { isQualifiedName, planInsert, type InsertPlan } from "./sql-insert";

/** Aplica o plano ao texto, como o editor faz. */
function apply(doc: string, plan: InsertPlan): string {
  return doc.slice(0, plan.from) + plan.insert + doc.slice(plan.to);
}
/** Simula um clique com o cursor no fim do texto. */
const click = (doc: string, text: string) => apply(doc, planInsert(doc, doc.length, doc.length, text));

describe("isQualifiedName", () => {
  it("reconhece schema.tabela (com ou sem colchetes) e não confunde com coluna", () => {
    expect(isQualifiedName("d_adl.vendas")).toBe(true);
    expect(isQualifiedName("d_adl.[Nome Tabela]")).toBe(true);
    expect(isQualifiedName("[d adl].[t]")).toBe(true);
    expect(isQualifiedName("chave_unica")).toBe(false);
    expect(isQualifiedName("[Valor Total]")).toBe(false);
    expect(isQualifiedName("a.b.c")).toBe(false);
  });
});

describe("planInsert - clique numa tabela", () => {
  const START = "SELECT TOP 100 *\nFROM ";

  it("primeiro clique: insere no lugar (sem espaço duplicado)", () => {
    expect(click(START, "ds.vendas")).toBe("SELECT TOP 100 *\nFROM ds.vendas");
  });

  it("segundo clique em OUTRA tabela TROCA a referência (antes virava `FROM ds.vendas ds.clientes` = syntax error at or near \".\")", () => {
    const one = click(START, "ds.vendas");
    expect(click(one, "ds.clientes")).toBe("SELECT TOP 100 *\nFROM ds.clientes");
  });

  it("clicar de novo na MESMA tabela não duplica", () => {
    const one = click(START, "ds.vendas");
    expect(click(one, "ds.vendas")).toBe("SELECT TOP 100 *\nFROM ds.vendas");
  });

  it("troca também quando a tabela atual está entre colchetes ou é só o nome", () => {
    expect(click("SELECT * FROM [ds].[Nome Tabela]", "ds.outra")).toBe("SELECT * FROM ds.outra");
    expect(click("SELECT * FROM vendas", "ds.outra")).toBe("SELECT * FROM ds.outra");
    expect(click("select * from ds.vendas", "ds.outra")).toBe("select * from ds.outra");
  });

  it("funciona com JOIN", () => {
    expect(click("SELECT * FROM ds.a a JOIN ds.b", "ds.c")).toBe("SELECT * FROM ds.a a JOIN ds.c");
  });

  it("NÃO troca quando já há alias, WHERE ou vírgula: acrescenta sem quebrar (JOIN de duas tabelas por vírgula)", () => {
    expect(click("SELECT * FROM ds.a a WHERE ", "ds.b")).toBe("SELECT * FROM ds.a a WHERE ds.b");
    expect(click("SELECT * FROM ds.a,", "ds.b")).toBe("SELECT * FROM ds.a,ds.b");
    expect(click("SELECT * FROM ds.a a", "ds.b")).toBe("SELECT * FROM ds.a a ds.b"); // alias: não adivinha
  });

  it("com texto selecionado, substitui só a seleção (comportamento normal do editor)", () => {
    const doc = "SELECT * FROM ds.vendas WHERE 1=1";
    const from = doc.indexOf("ds.vendas");
    expect(apply(doc, planInsert(doc, from, from + "ds.vendas".length, "ds.clientes"))).toBe("SELECT * FROM ds.clientes WHERE 1=1");
  });

  it("cursor no meio do texto (não no fim): só insere, não troca a tabela mais adiante", () => {
    const doc = "SELECT  FROM ds.vendas";
    const at = "SELECT ".length;
    expect(apply(doc, planInsert(doc, at, at, "ds.clientes"))).toBe("SELECT ds.clientes FROM ds.vendas");
  });
});

describe("planInsert - clique numa coluna", () => {
  it("coluna nunca troca tabela: só separa com espaço quando precisa", () => {
    expect(click("SELECT ", "chave_unica")).toBe("SELECT chave_unica");
    expect(click("SELECT chave_unica", "valor")).toBe("SELECT chave_unica valor"); // separação simples, como antes
    expect(click("SELECT chave_unica,", "valor")).toBe("SELECT chave_unica,valor");
    expect(click("SELECT * FROM ds.vendas WHERE ", "[Valor Total]")).toBe("SELECT * FROM ds.vendas WHERE [Valor Total]");
    expect(click("SELECT * FROM ds.vendas", "chave_unica")).toBe("SELECT * FROM ds.vendas chave_unica"); // como antes (vira alias)
  });

  it("documento vazio ou cursor no início: sem espaço à esquerda", () => {
    expect(apply("", planInsert("", 0, 0, "chave_unica"))).toBe("chave_unica");
  });
});
