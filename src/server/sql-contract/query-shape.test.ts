import { describe, expect, it } from "vitest";
import { firstTopN, hasTopLevelOrderBy, paginationWarnings } from "./query-shape";

describe("hasTopLevelOrderBy", () => {
  it("acha o ORDER BY de fora", () => {
    expect(hasTopLevelOrderBy("SELECT a FROM t ORDER BY a")).toBe(true);
    expect(hasTopLevelOrderBy("select a from t order   by a desc")).toBe(true);
    expect(hasTopLevelOrderBy("SELECT TOP 5 a FROM t\nORDER BY a")).toBe(true);
  });
  it("ignora ORDER BY de subconsulta, de OVER (...) e de literal/comentario/identificador", () => {
    expect(hasTopLevelOrderBy("SELECT ROW_NUMBER() OVER (ORDER BY a) rn FROM t")).toBe(false);
    expect(hasTopLevelOrderBy("SELECT * FROM (SELECT TOP 5 a FROM t ORDER BY a) x")).toBe(false);
    expect(hasTopLevelOrderBy("SELECT 'order by x' AS s FROM t")).toBe(false);
    expect(hasTopLevelOrderBy("SELECT a FROM t -- ORDER BY a")).toBe(false);
    expect(hasTopLevelOrderBy("SELECT [order by] FROM t")).toBe(false);
    expect(hasTopLevelOrderBy("SELECT a FROM border_by")).toBe(false);
  });
  it("ORDER BY de fora conta mesmo com subconsulta antes", () => {
    expect(hasTopLevelOrderBy("SELECT * FROM (SELECT a FROM t) x ORDER BY a")).toBe(true);
  });
});

describe("firstTopN", () => {
  it("le TOP n, TOP (n) e DISTINCT TOP", () => {
    expect(firstTopN("SELECT TOP 20000 a FROM t")).toBe(20000);
    expect(firstTopN("SELECT TOP (50) a FROM t")).toBe(50);
    expect(firstTopN("SELECT DISTINCT TOP 7 a FROM t")).toBe(7);
  });
  it("null sem TOP ou com TOP so em literal", () => {
    expect(firstTopN("SELECT a FROM t")).toBeNull();
    expect(firstTopN("SELECT 'SELECT TOP 5' AS s FROM t")).toBeNull();
  });
});

describe("paginationWarnings", () => {
  it("offset sem ORDER BY avisa; com ORDER BY ou sem offset, nao", () => {
    expect(paginationWarnings("SELECT a FROM t", 100, 100)).toHaveLength(1);
    expect(paginationWarnings("SELECT a FROM t ORDER BY a", 100, 100)).toEqual([]);
    expect(paginationWarnings("SELECT a FROM t", 100, 0)).toEqual([]);
  });
  it("TOP acima do limite avisa que o resultado vem paginado", () => {
    const w = paginationWarnings("SELECT TOP 50000 a FROM t ORDER BY a", 10000, 0);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("TOP 50000");
    expect(paginationWarnings("SELECT TOP 50 a FROM t ORDER BY a", 10000, 0)).toEqual([]);
  });
});
