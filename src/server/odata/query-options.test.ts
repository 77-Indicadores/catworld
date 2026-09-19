import { describe, expect, it } from "vitest";
import { planODataQuery, translateFilter, translateOrderBy, UnsupportedODataOption, type ODataColumn } from "./query-options";

const cols: ODataColumn[] = [
  { sqlName: "id", sqlType: "BIGINT" },
  { sqlName: "nome", sqlType: "NVARCHAR(MAX)" },
  { sqlName: "valor", sqlType: "DECIMAL(18,4)" },
  { sqlName: "dia", sqlType: "DATE" },
  { sqlName: "dt", sqlType: "DATETIME2" },
  { sqlName: "ativo", sqlType: "BIT" },
];
const ref = (c: { sqlName: string }) => `"${c.sqlName}"`;
const f = (s: string) => translateFilter(s, cols, ref);

describe("translateFilter", () => {
  it("comparacoes basicas", () => {
    expect(f("id eq 1")).toBe('("id" = 1)');
    expect(f("id ne 1")).toBe('("id" <> 1)');
    expect(f("valor ge 10.5 and valor lt 20")).toBe('(("valor" >= 10.5) AND ("valor" < 20))');
    expect(f("nome eq 'ana'")).toBe(`("nome" = 'ana')`);
  });
  it("and/or/not/parenteses com precedencia correta", () => {
    expect(f("id eq 1 or id eq 2 and nome eq 'x'")).toBe(`(("id" = 1) OR (("id" = 2) AND ("nome" = 'x')))`);
    expect(f("not (id eq 1)")).toBe('(NOT ("id" = 1))');
    expect(f("(id eq 1 or id eq 2) and ativo eq true")).toBe('((("id" = 1) OR ("id" = 2)) AND ("ativo" = TRUE))');
  });
  it("null vira IS NULL / IS NOT NULL", () => {
    expect(f("nome eq null")).toBe('("nome" IS NULL)');
    expect(f("nome ne null")).toBe('("nome" IS NOT NULL)');
  });
  it("datas e datetimes", () => {
    expect(f("dia ge 2026-01-31")).toBe(`("dia" >= DATE '2026-01-31')`);
    expect(f("dt gt 2026-01-31T10:00:00Z")).toBe(`("dt" > TIMESTAMP '2026-01-31 10:00:00.000')`);
    expect(f("dt ge 2026-01-31")).toContain("CAST(DATE '2026-01-31' AS TIMESTAMP)"); // datetime x date
  });
  it("contains/startswith/endswith escapam %, _ e \\ do valor", () => {
    expect(f("contains(nome,'an')")).toBe(`("nome" LIKE '%an%' ESCAPE '\\')`);
    expect(f("startswith(nome,'a_b%')")).toBe(`("nome" LIKE 'a\\_b\\%%' ESCAPE '\\')`);
    expect(f("endswith(nome,'z')")).toBe(`("nome" LIKE '%z' ESCAPE '\\')`);
  });
  it("year/month/day", () => {
    expect(f("year(dia) eq 2026")).toBe('(EXTRACT(YEAR FROM "dia") = 2026)');
    expect(f("month(dt) ge 6")).toBe('(EXTRACT(MONTH FROM "dt") >= 6)');
  });
  it("aspas simples no valor sao escapadas — nada cru vai para o SQL", () => {
    expect(f("nome eq 'o''brien'")).toBe(`("nome" = 'o''brien')`);
    expect(f(`nome eq 'x'' OR ''1''=''1'`)).toBe(`("nome" = 'x'' OR ''1''=''1')`);
  });
  it.each([
    ["coluna inexistente", "nada eq 1"],
    ["texto em coluna numerica", "id eq 'abc'"],
    ["numero em coluna de texto", "nome eq 5"],
    ["funcao desconhecida", "tolower(nome) eq 'a'"],
    ["parentese aberto", "(id eq 1"],
    ["texto sobrando", "id eq 1 xyz"],
    ["operador de comparacao em null", "id gt null"],
    ["injecao por caractere", "id eq 1; DROP TABLE t"],
    ["string sem fechar", "nome eq 'abc"],
    ["bool com gt", "ativo gt true"],
  ])("nao suportado (%s) lanca e nunca gera SQL", (_l, expr) => {
    expect(() => f(expr)).toThrow(UnsupportedODataOption);
  });
});

describe("translateOrderBy", () => {
  it("colunas com asc/desc e NULL como menor valor", () => {
    expect(translateOrderBy("nome desc, id", cols, ref)).toBe('"nome" DESC NULLS LAST, "id" ASC NULLS FIRST');
  });
  it("rejeita coluna inexistente e expressao", () => {
    expect(() => translateOrderBy("nada", cols, ref)).toThrow(UnsupportedODataOption);
    expect(() => translateOrderBy("id; DROP", cols, ref)).toThrow(UnsupportedODataOption);
    expect(() => translateOrderBy("tolower(nome)", cols, ref)).toThrow(UnsupportedODataOption);
  });
});

describe("planODataQuery — nunca lanca; o que nao entende vira aviso e e ignorado (como sempre foi)", () => {
  const plan = (qs: string, supported = true) => planODataQuery(new URLSearchParams(qs), cols, ref, supported);

  it("aplica o suportado", () => {
    const p = plan("$filter=id eq 1&$orderby=nome desc");
    expect(p.where).toBe('("id" = 1)');
    expect(p.orderBy).toBe('"nome" DESC NULLS LAST');
    expect(p.warnings).toEqual([]);
  });
  it("$filter invalido: ignora e avisa (nao 400)", () => {
    const p = plan("$filter=tolower(nome) eq 'a'");
    expect(p.where).toBeNull();
    expect(p.warnings[0]).toContain("$filter ignorado");
  });
  it("backend sem suporte (SQL Server): ignora e avisa", () => {
    const p = plan("$filter=id eq 1&$orderby=id", false);
    expect(p.where).toBeNull();
    expect(p.orderBy).toBeNull();
    expect(p.warnings).toHaveLength(2);
  });
  it("opcoes nao implementadas avisam", () => {
    expect(plan("$expand=x&$search=abc").warnings.join("|")).toMatch(/\$expand.*\$search|\$search.*\$expand/);
  });
  it("sem opcoes: plano vazio (comportamento anterior intacto)", () => {
    expect(plan("$top=10&$skip=5&$select=id&$count=true")).toEqual({ where: null, orderBy: null, warnings: [] });
  });
});
