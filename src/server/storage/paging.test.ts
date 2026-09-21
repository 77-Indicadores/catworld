import { describe, expect, it } from "vitest";
import { addTieBreaker } from "./paging";

describe("addTieBreaker", () => {
  it("acrescenta as colunas ao ORDER BY existente", () => {
    const r = addTieBreaker("SELECT a, b FROM t ORDER BY a DESC", [23, 25]);
    expect(r).toMatchObject({ sql: "SELECT a, b FROM t ORDER BY a DESC, 1, 2", applied: true, hadOrderBy: true });
  });
  it("cria ORDER BY quando nao ha", () => {
    const r = addTieBreaker("SELECT a FROM t;", [23]);
    expect(r).toMatchObject({ sql: "SELECT a FROM t ORDER BY 1", hadOrderBy: false });
  });
  it("insere antes de LIMIT/OFFSET de topo", () => {
    expect(addTieBreaker("SELECT a FROM t ORDER BY a LIMIT 5 OFFSET 2", [23]).sql).toBe("SELECT a FROM t ORDER BY a, 1 LIMIT 5 OFFSET 2");
    expect(addTieBreaker("SELECT a FROM t LIMIT 5", [23]).sql).toBe("SELECT a FROM t ORDER BY 1 LIMIT 5");
  });
  it("ignora ORDER BY em subconsulta, literal e comentario", () => {
    const r = addTieBreaker("SELECT a FROM (SELECT a FROM t ORDER BY a LIMIT 3) x WHERE n = 'order by z' -- order by q", [23]);
    expect(r.hadOrderBy).toBe(false);
    expect(r.sql).toContain("ORDER BY 1");
  });
  it("UNION: o ORDER BY de topo vale para o conjunto", () => {
    const r = addTieBreaker("SELECT a FROM x UNION ALL SELECT a FROM y ORDER BY 1", [23]);
    expect(r.sql).toBe("SELECT a FROM x UNION ALL SELECT a FROM y ORDER BY 1, 1");
  });
  it("colunas json/xml ficam fora", () => {
    const r = addTieBreaker("SELECT a, j FROM t", [23, 114]);
    expect(r).toMatchObject({ sql: "SELECT a, j FROM t ORDER BY 1", skippedColumns: 1 });
    expect(addTieBreaker("SELECT j FROM t", [114]).applied).toBe(false);
  });
  it("SUBSTRING(... FOR n) dentro de parenteses nao e tomado como FOR de topo", () => {
    expect(addTieBreaker("SELECT SUBSTRING(a FROM 1 FOR 2) FROM t", [25]).sql).toBe("SELECT SUBSTRING(a FROM 1 FOR 2) FROM t ORDER BY 1");
  });
  it("t.offset / AS limit / AS for nao sao o rabo da consulta", () => {
    expect(addTieBreaker("SELECT a, t.offset FROM t", [23, 23]).sql).toBe("SELECT a, t.offset FROM t ORDER BY 1, 2");
    expect(addTieBreaker("SELECT a AS limit, b FROM t", [23, 23]).sql).toBe("SELECT a AS limit, b FROM t ORDER BY 1, 2");
    expect(addTieBreaker("SELECT a, b AS fetch FROM t ORDER BY a LIMIT 5", [23, 23]).sql).toBe("SELECT a, b AS fetch FROM t ORDER BY a, 1, 2 LIMIT 5");
  });
  it("comentario no fim: o desempate nao cai dentro dele", () => {
    const r = addTieBreaker("SELECT a FROM t ORDER BY a -- ordena", [23]);
    expect(r.sql).toBe("SELECT a FROM t ORDER BY a, 1");
    expect(addTieBreaker("SELECT a FROM t ORDER BY a /* x /* aninhado */ y */", [23]).sql).toBe("SELECT a FROM t ORDER BY a, 1");
  });
  it("E'...\'...' nao desalinha a leitura", () => {
    const r = addTieBreaker("SELECT E'it\'s ORDER BY' AS x FROM t ORDER BY 1", [25]);
    expect(r.sql).toBe("SELECT E'it\'s ORDER BY' AS x FROM t ORDER BY 1, 1");
  });
  it("tipos sem ordenacao (jsonpath, xid, cid, aclitem, pg_snapshot) ficam fora", () => {
    for (const oid of [4072, 28, 29, 1033, 5038]) expect(addTieBreaker("SELECT a, x FROM t", [23, oid])).toMatchObject({ sql: "SELECT a, x FROM t ORDER BY 1", skippedColumns: 1 });
  });
});

