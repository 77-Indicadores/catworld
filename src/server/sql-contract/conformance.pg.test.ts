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
});
