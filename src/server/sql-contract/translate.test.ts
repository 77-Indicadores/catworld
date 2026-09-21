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

  it("identificador entre aspas duplas mantem a caixa exata (delimitado, como no T-SQL)", () => {
    const r = pg('SELECT "Id", "Nome Cliente" FROM "Vendas" ORDER BY "Id"');
    expect(r.sql).toContain('"Id"');
    expect(r.sql).toContain('"Nome Cliente"');
    expect(r.sql).toContain('"Vendas"');
    expect(r.sql).not.toMatch(/"id"/);
  });

  it("comentario e string com palavras-chave nao sao tocados", () => {
    const r = pg("SELECT 'TOP 5 [x] ISNULL(' AS s FROM t -- SELECT TOP 9");
    expect(r.sql).toContain("'TOP 5 [x] ISNULL('");
    expect(r.topLimit).toBeNull();
  });

  it("funcoes: ISNULL, LEN, GETDATE, IIF, DATEADD", () => {
    const r = pg("SELECT ISNULL(b,0), LEN(c), IIF(a>1,'x','y') FROM t WHERE d > DATEADD(day,-7,GETDATE())").sql;
    expect(r).toContain("COALESCE(b, 0)");
    expect(r).toContain("LENGTH(RTRIM(CAST(c AS TEXT)))");
    expect(r).toContain("CASE WHEN a > 1 THEN 'x' ELSE 'y' END");
    expect(r).toContain("NOW() + (-7) * INTERVAL '1 day'");
  });

  it("DATEDIFF conta fronteiras", () => {
    expect(pg("SELECT DATEDIFF(day, a, b) FROM t").sql).toContain("CAST(b AS DATE) - CAST(a AS DATE)");
    expect(pg("SELECT DATEDIFF(month, a, b) FROM t").sql).toContain("* 12");
  });

  it("CONVERT com estilo de texto e CAST de tipos", () => {
    expect(pg("SELECT CONVERT(VARCHAR(10), d, 120) FROM t").sql).toContain("to_char(d, 'YYYY-MM-DD HH24:MI:SS')");
    expect(pg("SELECT CONVERT(INT, x) FROM t").sql).toContain("CAST(TRUNC(CAST(x AS NUMERIC)) AS INTEGER)");
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
      "SELECT TRY_CAST(a AS DATE) FROM t",
      "SELECT TRY_CONVERT(BIT, a) FROM t",
      "SELECT * FROM t PIVOT (SUM(v) FOR c IN ([a],[b])) p",
      "SELECT DATEDIFF(millisecond, a, b) FROM t",
      "SELECT CONVERT(VARCHAR, d, 7) FROM t",
      "SELECT TOP 5 PERCENT a FROM t",
      "SELECT a::text FROM t",
    ]) {
      expect(() => pg(q), q).toThrow(SqlContractError);
    }
  });

  it("subconjunto ampliado: TRY_CAST numerico, CHARINDEX com inicio, semana, APPLY", () => {
    expect(pg("SELECT TRY_CAST(a AS INT) FROM t").sql).toMatch(/CAST\(\(CASE WHEN CAST\(a AS TEXT\) ~/);
    expect(pg("SELECT TRY_CONVERT(DECIMAL(10,2), a) FROM t").sql).toContain("DECIMAL(10,2)");
    expect(pg("SELECT CHARINDEX('a', b, 3) FROM t").sql).toContain("SUBSTRING(LOWER(CAST(b AS TEXT)) FROM 3)");
    expect(pg("SELECT DATEDIFF(week, a, b) FROM t").sql).toContain("1900-01-07");
    expect(pg("SELECT DATEPART(weekday, d) FROM t").sql).toContain("EXTRACT(DOW FROM d)");
    expect(pg("SELECT a FROM t CROSS APPLY (SELECT TOP 1 b FROM u WHERE u.id = t.id) x").sql).toMatch(/CROSS JOIN LATERAL .*LIMIT 1/);
    expect(pg("SELECT a FROM t OUTER APPLY (SELECT TOP 1 b FROM u WHERE u.id = t.id) x").sql).toMatch(/LEFT JOIN LATERAL .* ON TRUE/);
  });

  it("semantica T-SQL: NULLS, LIKE, LEN, CAST inteiro e '1' + 2", () => {
    const o = pg("SELECT a FROM t ORDER BY a, b DESC").sql;
    expect(o).toMatch(/ORDER BY a ASC NULLS FIRST, b DESC NULLS LAST/i);
    expect(pg("SELECT ROW_NUMBER() OVER (PARTITION BY g ORDER BY x) FROM t").sql).toMatch(/ORDER BY x ASC NULLS FIRST/i);
    expect(pg("SELECT 1 FROM t WHERE n LIKE 'b%' AND m NOT LIKE 'x%'").sql).toContain("(n ILIKE 'b%' ESCAPE '') AND (m NOT ILIKE 'x%' ESCAPE '')");
    expect(pg("SELECT LEN(c) FROM t").sql).toContain("LENGTH(RTRIM(CAST(c AS TEXT)))");
    expect(pg("SELECT CAST(x AS INT), CAST(y AS BIGINT), CAST(z AS DECIMAL(10,2)) FROM t").sql)
      .toMatch(/CAST\(TRUNC\(CAST\(x AS NUMERIC\)\) AS INTEGER\).*AS BIGINT\).*CAST\(z AS DECIMAL\(10,2\)\)/);
    expect(pg("SELECT '1' + 2 FROM t").sql).toContain("'1' + 2"); // continua aritmetico
    expect(pg("SELECT n + '-' FROM t").sql).toContain("||");     // texto: concatena
  });
});

describe("revisao independente: achados B2/H1/M1/M2/LOW", () => {
  it("B2: STRING_AGG e TRANSLATE passam (Postgres tem a mesma semantica)", () => {
    expect(() => pg("SELECT STRING_AGG(nome, ',') FROM t")).not.toThrow();
    expect(() => pg("SELECT TRANSLATE(nome, 'abc', 'xyz') FROM t")).not.toThrow();
    expect(pg("SELECT STRING_AGG(nome, ',') FROM t").sql).toMatch(/STRING_AGG/i);
  });

  it("H1: expressoes provadamente texto + '1' concatenam (nao sao ambiguas)", () => {
    for (const e of [
      "ISNULL(a, '') + '1'", "COALESCE(a, 'x') + '1'", "LEFT(Code, 2) + '1'", "RIGHT(Code, 2) + '1'", "TRIM(Code) + '1'",
      "NULLIF(a, '') + '1'", "REVERSE(a) + '1'", "REPLICATE('a', 2) + '1'", "CONCAT_WS('-', a, b) + '1'",
      "CAST(a AS VARCHAR(10)) + '1'", "CONVERT(VARCHAR, a) + '1'", "CASE WHEN a = 1 THEN 'x' ELSE 'y' END + '1'",
    ]) {
      const r = pg(`SELECT ${e} AS r FROM t`);
      expect(r.sql, e).toContain("||");
    }
  });

  it("H1: o caso ambiguo continua rejeitado", () => {
    expect(() => pg("SELECT Code + '1' FROM t")).toThrow(SqlContractError);
    expect(() => pg("SELECT ISNULL(a, b) + '1' FROM t")).toThrow(SqlContractError);
    expect(() => pg("SELECT CASE WHEN a = 1 THEN 'x' ELSE b END + '1' FROM t")).toThrow(SqlContractError);
  });

  it("M1: palavras rejeitadas dentro de comentarios nao contam", () => {
    expect(() => pg("SELECT a FROM t -- STRING_AGG(x) FORMAT(x)")).not.toThrow();
    expect(() => pg("SELECT a /* FORMAT(x) */ FROM t")).not.toThrow();
    expect(() => pg("SELECT FORMAT(a, 'N') FROM t")).toThrow(SqlContractError);
  });

  it("LOW: apostrofo dentro de comentario nao desalinha a leitura de literais", () => {
    const r = pg("SELECT a FROM t /* it's */ WHERE b LIKE '[a]%'");
    expect(r.sql).toContain("^[a].*$");
    expect(r.sql).not.toContain("cwq_");
  });

  it("M2: TOP em UNION dentro de CTE / tabela derivada / IN-subquery vira ramo com LIMIT valido", () => {
    for (const q of [
      "WITH c AS (SELECT TOP 2 a FROM t UNION ALL SELECT a FROM u) SELECT * FROM c",
      "SELECT * FROM (SELECT TOP 2 a FROM t UNION ALL SELECT a FROM u) d",
      "SELECT a FROM t WHERE a IN (SELECT TOP 2 a FROM t UNION ALL SELECT a FROM u)",
    ]) {
      const s = pg(q).sql;
      expect(s, q).not.toMatch(/LIMIT 2\s+UNION/i);
      expect(s, q).toMatch(/LIMIT 2/);
    }
  });

  it("LOW: CHARINDEX com start <= 0 vale 1; REPLICATE / DATEFROMPARTS truncam o numero", () => {
    expect(pg("SELECT CHARINDEX('a', b, 0) FROM t").sql).toMatch(/GREATEST/i);
    expect(pg("SELECT REPLICATE('a', 2.7) FROM t").sql).toMatch(/TRUNC/i);
    expect(pg("SELECT DATEFROMPARTS(2024.9, 1, 2) FROM t").sql).toMatch(/TRUNC/i);
  });
});
