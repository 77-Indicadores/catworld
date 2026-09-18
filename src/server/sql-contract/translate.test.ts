import { describe, expect, it } from "vitest";
import { SqlContractError, translateTsql } from "./translate";

const pg = (s: string) => translateTsql(s, "postgres");

describe("translateTsql -> postgres", () => {
  it("mssql passa direto", () => {
    expect(translateTsql("SELECT TOP 5 * FROM t", "mssql").sql).toBe("SELECT TOP 5 * FROM t");
  });

  it("TOP externo vira topLimit; TOP em subquery/CTE vira LIMIT", () => {
    const r = pg("SELECT TOP 10 a FROM t");
    expect(r.topLimit).toBe(10);
    expect(r.sql).not.toMatch(/TOP|LIMIT/i);
    const c = pg("WITH c AS (SELECT TOP 5 a FROM t ORDER BY a) SELECT * FROM c");
    expect(c.topLimit).toBeNull();
    expect(c.sql).toMatch(/LIMIT 5/);
  });

  it("colchetes mantem caixa exata; sem colchetes vira minusculo", () => {
    const r = pg("SELECT [Nome Cliente], Valor FROM [Vendas]");
    expect(r.sql).toContain('"Nome Cliente"');
    expect(r.sql).toContain('"Vendas"');
    expect(r.sql).toMatch(/\bvalor\b/);
  });

  it("comentario e string com palavras-chave nao sao tocados", () => {
    const r = pg("SELECT 'TOP 5 [x] ISNULL(' AS s FROM t -- SELECT TOP 9");
    expect(r.sql).toContain("'TOP 5 [x] ISNULL('");
    expect(r.topLimit).toBeNull();
  });

  it("funcoes: ISNULL, LEN, GETDATE, IIF, DATEADD", () => {
    const r = pg("SELECT ISNULL(b,0), LEN(c), IIF(a>1,'x','y') FROM t WHERE d > DATEADD(day,-7,GETDATE())").sql;
    expect(r).toContain("COALESCE(b, 0)");
    expect(r).toContain("LENGTH(c)");
    expect(r).toContain("CASE WHEN a > 1 THEN 'x' ELSE 'y' END");
    expect(r).toContain("LOCALTIMESTAMP + (-7) * INTERVAL '1 day'");
  });

  it("DATEDIFF conta fronteiras", () => {
    expect(pg("SELECT DATEDIFF(day, a, b) FROM t").sql).toContain("CAST(b AS DATE) - CAST(a AS DATE)");
    expect(pg("SELECT DATEDIFF(month, a, b) FROM t").sql).toContain("* 12");
  });

  it("CONVERT com estilo de texto e CAST de tipos", () => {
    expect(pg("SELECT CONVERT(VARCHAR(10), d, 120) FROM t").sql).toContain("to_char(d, 'YYYY-MM-DD HH24:MI:SS')");
    expect(pg("SELECT CONVERT(INT, x) FROM t").sql).toContain("CAST(x AS INTEGER)");
    expect(pg("SELECT CAST(x AS NVARCHAR(50)) FROM t").sql).toMatch(/CAST\(x AS TEXT\)/i);
  });

  it("concatenacao com + e literal vira ||", () => {
    expect(pg("SELECT a + '-' + b FROM t").sql).toContain("||");
  });

  it("NOLOCK e removido", () => {
    expect(pg("SELECT a FROM t WITH (NOLOCK)").sql).not.toMatch(/nolock/i);
  });

  it("construcoes fora do subconjunto viram UNSUPPORTED_CONSTRUCT", () => {
    for (const q of [
      "SELECT TRY_CAST(a AS INT) FROM t",
      "SELECT a FROM t CROSS APPLY f(a) x",
      "SELECT DATEDIFF(week, a, b) FROM t",
      "SELECT CONVERT(VARCHAR, d, 7) FROM t",
      "SELECT CHARINDEX('a', b, 3) FROM t",
      "SELECT TOP 5 PERCENT a FROM t",
    ]) {
      expect(() => pg(q), q).toThrow(SqlContractError);
    }
  });
});
