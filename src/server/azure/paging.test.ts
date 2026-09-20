import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/storage/pool", () => ({ getStoragePool: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ addBreadcrumb() {} }));

import { buildPagedStatement } from "./sql";

describe("buildPagedStatement (SQL Server)", () => {
  it("ORDER BY de fora: acrescenta OFFSET/FETCH", () => {
    const r = buildPagedStatement("SELECT a FROM t ORDER BY a", 5, 11);
    expect(r).toEqual({ paged: "SELECT a FROM t ORDER BY a OFFSET 5 ROWS FETCH NEXT 11 ROWS ONLY", clientSkip: -1 });
  });
  it("sem ORDER BY: embrulha", () => {
    expect(buildPagedStatement("SELECT a FROM t", 0, 11).paged).toBe("SELECT * FROM (SELECT a FROM t) AS _cw_q ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT 11 ROWS ONLY");
  });
  it("TOP n com ORDER BY: embrulha (nunca OFFSET direto, seria SQL invalido)", () => {
    const r = buildPagedStatement("SELECT TOP 2 a FROM t ORDER BY a", 1, 11);
    expect(r.paged).toMatch(/^SELECT \* FROM \(SELECT TOP 2 a FROM t ORDER BY a\) AS _cw_q ORDER BY/);
  });
  it("OFFSET proprio: embrulha", () => {
    expect(buildPagedStatement("SELECT a FROM t ORDER BY a OFFSET 3 ROWS FETCH NEXT 4 ROWS ONLY", 1, 11).paged).toMatch(/^SELECT \* FROM \(/);
  });
  it("ORDER BY / TOP so em literal ou comentario nao contam", () => {
    const r = buildPagedStatement("SELECT 'ORDER BY x' AS a /* TOP 1 */ FROM t", 0, 11);
    expect(r.paged).toMatch(/^SELECT \* FROM \(/);
    expect(r.clientSkip).toBe(-1);
  });
  it("TOP dentro de subconsulta nao impede o OFFSET de fora", () => {
    const r = buildPagedStatement("SELECT a FROM (SELECT TOP 5 a FROM t ORDER BY a) x ORDER BY a", 0, 11);
    expect(r.paged.endsWith("ORDER BY a OFFSET 0 ROWS FETCH NEXT 11 ROWS ONLY")).toBe(true);
    expect(r.paged.startsWith("SELECT a FROM (")).toBe(true);
  });
  it("CTE com TOP proprio: nao da para embrulhar; offset aplicado no Node", () => {
    const r = buildPagedStatement("WITH x AS (SELECT 1 AS a) SELECT TOP 3 a FROM x", 2, 11);
    expect(r).toEqual({ paged: "WITH x AS (SELECT 1 AS a) SELECT TOP 3 a FROM x", clientSkip: 2 });
  });
  it("CTE simples sem ORDER BY: ORDER BY (SELECT NULL)", () => {
    expect(buildPagedStatement("WITH x AS (SELECT 1 AS a) SELECT a FROM x", 0, 11).paged).toContain("ORDER BY (SELECT NULL) OFFSET 0");
  });
});
