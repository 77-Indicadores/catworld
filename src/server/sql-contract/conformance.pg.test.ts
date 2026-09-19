/**
 * Conformidade: executa o SQL TRADUZIDO num Postgres de verdade e compara com o
 * resultado que o T-SQL daria no SQL Server (valores esperados escritos a mao).
 *
 * Roda so com CW_TEST_PG_URL (Postgres descartavel — NUNCA aponte para producao):
 *   CW_TEST_PG_URL=postgres://test@localhost:55432/postgres npx vitest run conformance
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { translateTsql } from "./translate";

const url = process.env.CW_TEST_PG_URL;
const d = url ? describe : describe.skip;

d("conformidade T-SQL -> Postgres (executando)", () => {
  const client = new Client({ connectionString: url });

  beforeAll(async () => {
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS cwt CASCADE; CREATE SCHEMA cwt; SET search_path TO cwt`);
    await client.query(`CREATE TABLE cwt.vendas ("Id" INT, nome TEXT, "Valor Total" DECIMAL(10,2), dt TIMESTAMP, dia DATE, nota TEXT)`);
    await client.query(`INSERT INTO cwt.vendas VALUES
      (1,'ana',10.50,'2026-01-31 23:59:00','2026-01-31',NULL),
      (2,'bia',20.00,'2026-02-01 00:01:00','2026-02-01','x'),
      (3,'cai',5.25,'2026-03-15 10:30:45','2026-03-15',NULL)`);
  });
  afterAll(async () => { await client.end(); });

  async function run(tsql: string) {
    const { sql, topLimit } = translateTsql(tsql, "postgres");
    const q = topLimit !== null ? `${sql} LIMIT ${topLimit}` : sql;
    const r = await client.query(q);
    return r.rows as Record<string, unknown>[];
  }
  const col = (rows: Record<string, unknown>[], k: string) => rows.map((r) => r[k]);

  it("TOP + ORDER BY + colchetes com espaco e caixa", async () => {
    const r = await run("SELECT TOP 2 [Id], [Valor Total] FROM cwt.vendas ORDER BY [Id] DESC");
    expect(col(r, "Id")).toEqual([3, 2]);
  });

  it("TOP dentro de CTE", async () => {
    const r = await run("WITH c AS (SELECT TOP 2 [Id] FROM cwt.vendas ORDER BY [Id]) SELECT COUNT(*) AS n FROM c");
    expect(Number(r[0]!.n)).toBe(2);
  });

  it("ISNULL, IIF, LEN", async () => {
    const r = await run("SELECT ISNULL(nota,'-') AS n, IIF([Id]>1,'a','b') AS f, LEN(nome) AS l FROM cwt.vendas ORDER BY [Id]");
    expect(col(r, "n")).toEqual(["-", "x", "-"]);
    expect(col(r, "f")).toEqual(["b", "a", "a"]);
    expect(col(r, "l")).toEqual([3, 3, 3]);
  });

  it("DATEDIFF conta fronteiras (como o SQL Server)", async () => {
    // 23:59 de 31/01 -> 00:01 de 01/02: 1 dia e 1 mes de FRONTEIRA, mesmo com 2 minutos de diferenca
    const r = await run("SELECT DATEDIFF(day, '2026-01-31 23:59:00', '2026-02-01 00:01:00') AS dd, DATEDIFF(month, '2026-01-31 23:59:00', '2026-02-01 00:01:00') AS mm, DATEDIFF(year, '2025-12-31', '2026-01-01') AS yy FROM cwt.vendas WHERE [Id]=1");
    expect(Number(r[0]!.dd)).toBe(1);
    expect(Number(r[0]!.mm)).toBe(1);
    expect(Number(r[0]!.yy)).toBe(1);
  });

  it("DATEADD e DATEPART / YEAR / MONTH", async () => {
    const r = await run("SELECT DATEADD(day, 30, dia) AS d30, DATEPART(month, dt) AS m, YEAR(dt) AS y FROM cwt.vendas WHERE [Id]=1");
    expect(new Date(r[0]!.d30 as string).toISOString().slice(0, 10)).toBe("2026-03-02");
    expect(r[0]!.m).toBe(1);
    expect(r[0]!.y).toBe(2026);
  });

  it("CONVERT com estilo e CAST", async () => {
    const r = await run("SELECT CONVERT(VARCHAR(10), dia, 23) AS a, CONVERT(VARCHAR(19), dt, 120) AS b, CAST([Valor Total] AS INT) AS c FROM cwt.vendas WHERE [Id]=3");
    expect(r[0]!.a).toBe("2026-03-15");
    expect(r[0]!.b).toBe("2026-03-15 10:30:45");
    expect(r[0]!.c).toBe(5);
  });

  it("concatenacao com + e CHARINDEX", async () => {
    const r = await run("SELECT nome + '-' + 'z' AS c, CHARINDEX('n', nome) AS p FROM cwt.vendas WHERE [Id]=1");
    expect(r[0]!.c).toBe("ana-z");
    expect(Number(r[0]!.p)).toBe(2);
  });

  it("GETDATE e NOLOCK", async () => {
    const r = await run("SELECT COUNT(*) AS n FROM cwt.vendas WITH (NOLOCK) WHERE dt < GETDATE()");
    expect(Number(r[0]!.n)).toBe(3);
  });

  it("agregacao + GROUP BY + HAVING + JOIN", async () => {
    const r = await run("SELECT a.nome, SUM(a.[Valor Total]) AS s FROM cwt.vendas a JOIN cwt.vendas b ON a.[Id]=b.[Id] GROUP BY a.nome HAVING SUM(a.[Valor Total]) > 6 ORDER BY a.nome");
    expect(col(r, "nome")).toEqual(["ana", "bia"]);
  });

  it("TRY_CAST numerico devolve NULL em vez de erro", async () => {
    const r = await run("SELECT TRY_CAST('12' AS INT) AS a, TRY_CAST('abc' AS INT) AS b, TRY_CAST('12.5' AS DECIMAL(10,2)) AS c, TRY_CONVERT(INT, 'x9') AS d FROM cwt.vendas WHERE [Id]=1");
    expect(r[0]!.a).toBe(12);
    expect(r[0]!.b).toBeNull();
    expect(Number(r[0]!.c)).toBe(12.5);
    expect(r[0]!.d).toBeNull();
  });

  it("CHARINDEX com posicao inicial", async () => {
    const r = await run("SELECT CHARINDEX('n', 'banana', 3) AS a, CHARINDEX('a', 'banana', 3) AS b, CHARINDEX('z', 'banana', 3) AS c FROM cwt.vendas WHERE [Id]=1");
    expect(Number(r[0]!.a)).toBe(3);
    expect(Number(r[0]!.b)).toBe(4);
    expect(Number(r[0]!.c)).toBe(0);
  });

  it("semana e dia da semana no padrao SQL Server (domingo = 1)", async () => {
    // 2026-02-01 e domingo; 2026-01-31 e sabado
    const r = await run("SELECT DATEDIFF(week, '2026-01-31', '2026-02-01') AS w1, DATEDIFF(week, '2026-02-01', '2026-02-07') AS w0, DATEPART(weekday, '2026-02-01') AS wd, DATEPART(dayofyear, '2026-02-01') AS doy, DATEPART(week, '2026-01-01') AS wk FROM cwt.vendas WHERE [Id]=1");
    expect(Number(r[0]!.w1)).toBe(1);
    expect(Number(r[0]!.w0)).toBe(0);
    expect(r[0]!.wd).toBe(1);
    expect(r[0]!.doy).toBe(32);
    expect(r[0]!.wk).toBe(1);
  });

  it("CROSS APPLY e OUTER APPLY", async () => {
    const c = await run("SELECT a.nome, x.v FROM cwt.vendas a CROSS APPLY (SELECT TOP 1 b.[Valor Total] AS v FROM cwt.vendas b WHERE b.[Id]=a.[Id]) x ORDER BY a.[Id]");
    expect(c.length).toBe(3);
    const o = await run("SELECT a.nome, x.v FROM cwt.vendas a OUTER APPLY (SELECT TOP 1 b.nome AS v FROM cwt.vendas b WHERE b.[Id]=a.[Id]+10) x ORDER BY a.[Id]");
    expect(o.length).toBe(3);
    expect(col(o, "v")).toEqual([null, null, null]);
  });

  it("estilos de CONVERT adicionais", async () => {
    const r = await run("SELECT CONVERT(VARCHAR(10), dia, 104) AS a, CONVERT(VARCHAR(10), dia, 111) AS b, CONVERT(VARCHAR(19), dt, 20) AS c FROM cwt.vendas WHERE [Id]=3");
    expect(r[0]!.a).toBe("15.03.2026");
    expect(r[0]!.b).toBe("2026/03/15");
    expect(r[0]!.c).toBe("2026-03-15 10:30:45");
  });

  // ---- semantica: mesmo resultado que o SQL Server daria ----
  it("NULL ordena como no T-SQL: primeiro em ASC, ultimo em DESC (tambem dentro de janela)", async () => {
    expect(col(await run("SELECT nota FROM cwt.vendas ORDER BY nota"), "nota")).toEqual([null, null, "x"]);
    expect(col(await run("SELECT nota FROM cwt.vendas ORDER BY nota DESC"), "nota")).toEqual(["x", null, null]);
    const w = await run("SELECT [Id], ROW_NUMBER() OVER (ORDER BY nota) AS rn FROM cwt.vendas ORDER BY [Id]");
    expect(col(w, "rn").map(Number)).toEqual([1, 3, 2]); // Id 2 tem nota 'x' -> ultimo
  });

  it("LIKE ignora maiusculas/minusculas (collation padrao do SQL Server)", async () => {
    expect(col(await run("SELECT nome FROM cwt.vendas WHERE nome LIKE 'B%'"), "nome")).toEqual(["bia"]);
    expect(col(await run("SELECT nome FROM cwt.vendas WHERE nome NOT LIKE 'B%' ORDER BY [Id]"), "nome")).toEqual(["ana", "cai"]);
  });

  it("CAST/CONVERT para inteiro TRUNCA (o Postgres arredondaria)", async () => {
    const r = await run("SELECT CAST(2.7 AS INT) AS a, CAST(-2.7 AS INT) AS b, CONVERT(INT, 2.9) AS c, CAST([Valor Total] AS INT) AS d, CAST(2.7 AS BIGINT) AS e FROM cwt.vendas WHERE [Id]=1");
    expect(Number(r[0]!.a)).toBe(2);
    expect(Number(r[0]!.b)).toBe(-2);
    expect(Number(r[0]!.c)).toBe(2);
    expect(Number(r[0]!.d)).toBe(10); // 10.50 -> 10 (arredondar daria 11)
    expect(Number(r[0]!.e)).toBe(2);
  });

  it("LEN ignora espacos finais (mas conta os iniciais) e devolve NULL para NULL", async () => {
    const r = await run("SELECT LEN('ab  ') AS a, LEN(' a ') AS b, LEN(nota) AS c FROM cwt.vendas WHERE [Id]=1");
    expect(Number(r[0]!.a)).toBe(2);
    expect(Number(r[0]!.b)).toBe(2);
    expect(r[0]!.c).toBeNull();
  });

  it("'1' + 2 e aritmetica (3); concatenacao de texto continua funcionando", async () => {
    const r = await run("SELECT '1' + 2 AS a, nome + '-' + nome AS b FROM cwt.vendas WHERE [Id]=1");
    expect(Number(r[0]!.a)).toBe(3);
    expect(r[0]!.b).toBe("ana-ana");
  });
});
