/**
 * Diferencial (ENT-08..14 + S1): o SQL TRADUZIDO roda num Postgres real e o resultado e comparado com o que o
 * SQL Server documenta para o T-SQL original (valores esperados escritos a mao, com a regra citada em cada caso).
 * So roda com CW_TEST_PG_URL (descartavel — NUNCA producao); schema com nome unico por execucao.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { SqlContractError, likeToRegex, translateTsql, type TranslateOptions } from "./translate";

const url = process.env.CW_TEST_PG_URL;
const d = url ? describe : describe.skip;
const SCH = `cwd_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`;

d("diferencial T-SQL x Postgres (ENT-08..14, S1)", () => {
  const client = new Client({ connectionString: url });

  beforeAll(async () => {
    await client.connect();
    await client.query(`CREATE SCHEMA "${SCH}"; SET search_path TO "${SCH}"`);
    await client.query(`CREATE TABLE p (id INT, nome TEXT, v BIGINT, dec NUMERIC(10,2), txt TEXT, dia DATE, dt TIMESTAMP)`);
    await client.query(`INSERT INTO p VALUES
      (1,'ana',10,1.50,'10.5','2026-01-31','2026-01-31 23:59:00'),
      (2,'Bia',20,2.50,'','2026-02-01','2026-02-01 00:01:00'),
      (3,'cai',NULL,NULL,'abc','2026-03-15','2026-03-15 10:30:45'),
      (4,'zed',7,4.00,'  12 ','2026-12-31','2026-12-31 08:00:00'),
      (5,'x\\y',1,1.00,'99999999999',NULL,NULL),
      (6,'50%',2,2.00,NULL,NULL,NULL),
      (7,'a[b]c',3,3.00,NULL,NULL,NULL)`);
  });
  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS "${SCH}" CASCADE`);
    await client.end();
  });

  async function run(tsql: string, options?: TranslateOptions) {
    const { sql, topLimit } = translateTsql(tsql, "postgres", options);
    const r = await client.query(topLimit !== null ? `${sql} LIMIT ${topLimit}` : sql);
    return r.rows as Record<string, unknown>[];
  }
  const one = async (tsql: string, options?: TranslateOptions) => (await run(tsql, options))[0]!.r;
  const ids = async (where: string) => (await run(`SELECT id AS r FROM p WHERE ${where} ORDER BY id`)).map((x) => x.r);

  // ---- ENT-08: CAST/CONVERT para VARCHAR(n) trunca em n ----
  describe("VARCHAR(n) trunca", () => {
    it("CAST('abcdef' AS VARCHAR(3)) = 'abc'", async () => expect(await one("SELECT CAST('abcdef' AS VARCHAR(3)) AS r")).toBe("abc"));
    it("CONVERT(VARCHAR(4), 'abcdef') = 'abcd'; NVARCHAR igual", async () => {
      expect(await one("SELECT CONVERT(VARCHAR(4), 'abcdef') AS r")).toBe("abcd");
      expect(await one("SELECT CONVERT(NVARCHAR(2), nome) AS r FROM p WHERE id = 1")).toBe("an");
    });
    it("sem tamanho: 30 (padrao de CAST/CONVERT do SQL Server)", async () => {
      expect(await one(`SELECT CAST('${"x".repeat(40)}' AS VARCHAR) AS r`)).toBe("x".repeat(30));
    });
    it("VARCHAR(MAX) nao trunca", async () => expect(await one(`SELECT CAST('${"x".repeat(40)}' AS VARCHAR(MAX)) AS r`)).toBe("x".repeat(40)));
    it("CONVERT(VARCHAR(10), dt, 120) = so a data", async () => {
      expect(await one("SELECT CONVERT(VARCHAR(10), dt, 120) AS r FROM p WHERE id = 1")).toBe("2026-01-31");
      expect(await one("SELECT CONVERT(VARCHAR(19), dt, 120) AS r FROM p WHERE id = 1")).toBe("2026-01-31 23:59:00");
    });
  });

  // ---- ENT-09: LIKE ----
  describe("LIKE do T-SQL", () => {
    it("classe [a-c]: casa 1a letra a..c (ignora caixa: Bia)", async () => expect(await ids("nome LIKE '[a-c]%'")).toEqual([1, 2, 3, 7]));  // ana, Bia, cai, a[b]c
    it("classe negada [^a-c]", async () => expect(await ids("nome LIKE '[^a-c]%'")).toEqual([4, 5, 6]));
    it("NOT LIKE com classe", async () => expect(await ids("nome NOT LIKE '[a-c]%'")).toEqual([4, 5, 6]));
    it("[%] e [_] casam o caractere literal", async () => {
      expect(await ids("nome LIKE '50[%]'")).toEqual([6]);
      expect(await ids("nome LIKE '[a]_[b]%'")).toEqual([7]); // 'a' + '_' (= '[') + 'b' + resto: casa 'a[b]c'
    });
    it("colchete literal via [[]", async () => expect(await ids("nome LIKE 'a[[]b]%'")).toEqual([7]));
    it("a barra invertida e literal (sem escape padrao): 'x\\%' casa 'x\\y', nao 'x'+qualquer", async () => {
      expect(await ids("nome LIKE 'x\\%'")).toEqual([5]);
      expect(await ids("nome LIKE 'x\\y'")).toEqual([5]);
    });
    it("%, _ e caixa continuam como no SQL Server", async () => {
      expect(await ids("nome LIKE 'ANA'")).toEqual([1]);
      expect(await ids("nome LIKE '_ia'")).toEqual([2]);
      expect(await ids("nome LIKE '%'")).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });
    it("padrao literal com aspas ('it''s')", async () => expect(await one("SELECT COUNT(*) AS r FROM p WHERE 'it''s' LIKE 'it''s'")).toBe("7"));
    it("padrao dinamico: caixa/barra corrigidas; classe vinda de expressao literal e rejeitada", async () => {
      expect(await ids("nome LIKE UPPER(nome)")).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(() => translateTsql("SELECT 1 FROM p WHERE nome LIKE UPPER('[a-c]') + nome", "postgres")).toThrow();
    });
    it("likeToRegex", () => {
      expect(likeToRegex("[a-c]%")).toBe("^[a-c].*$");
      expect(likeToRegex("a.b_")).toBe("^a\\.b.$");
      expect(likeToRegex("[^0-9]")).toBe("^[^0-9]$");
      expect(likeToRegex("x[")).toBe("^x\\[$");
      expect(likeToRegex("a\\b")).toBe("^a\\\\b$");
    });
  });

  // ---- ENT-10: TRY_CAST numerico para INT ----
  describe("TRY_CAST para INT", () => {
    const tc = (expr: string, type = "INT") => one(`SELECT TRY_CAST(${expr} AS ${type}) AS r`);
    it("numerico 10.5 -> 10 (trunca); -3.9 -> -3", async () => {
      expect(await tc("10.5")).toBe(10);
      expect(await tc("-3.9")).toBe(-3);
      expect(await one("SELECT TRY_CAST(dec AS INT) AS r FROM p WHERE id = 1")).toBe(1); // 1.50
    });
    it("'' e so espacos -> 0", async () => {
      expect(await tc("''")).toBe(0);
      expect(await tc("'   '")).toBe(0);
      expect(await one("SELECT TRY_CAST(txt AS INT) AS r FROM p WHERE id = 2")).toBe(0);
    });
    it("texto '10.5' e 'abc' -> NULL; '  12 ' -> 12; '12' -> 12", async () => {
      expect(await tc("'10.5'")).toBeNull();
      expect(await tc("'abc'")).toBeNull();
      expect(await one("SELECT TRY_CAST(txt AS INT) AS r FROM p WHERE id = 4")).toBe(12);
      expect(await tc("'12'")).toBe(12);
      expect(await one("SELECT TRY_CAST(txt AS INT) AS r FROM p WHERE id = 1")).toBeNull(); // txt = '10.5' (texto)
    });
    it("fora da faixa -> NULL (nao erro); BIGINT aceita; NULL -> NULL", async () => {
      expect(await one("SELECT TRY_CAST(txt AS INT) AS r FROM p WHERE id = 5")).toBeNull();  // 99999999999
      expect(await one("SELECT TRY_CAST(txt AS BIGINT) AS r FROM p WHERE id = 5")).toBe("99999999999");
      expect(await one("SELECT TRY_CAST(txt AS INT) AS r FROM p WHERE id = 6")).toBeNull();
    });
    it("DECIMAL: '' -> 0.00 e '10.5' -> 10.50", async () => {
      expect(await tc("''", "DECIMAL(10,2)")).toBe("0.00");
      expect(await tc("'10.5'", "DECIMAL(10,2)")).toBe("10.50");
      expect(await tc("'abc'", "DECIMAL(10,2)")).toBeNull();
    });
  });

  // ---- ENT-11: int + 'literal' ----
  describe("+ com literal de texto", () => {
    it("texto + literal concatena", async () => expect(await one("SELECT nome + '!' AS r FROM p WHERE id = 1")).toBe("ana!"));
    it("nome + ' ' + nome (idioma comum) concatena", async () => expect(await one("SELECT nome + ' ' + nome AS r FROM p WHERE id = 1")).toBe("ana ana"));
    it("coluna + '5' e AMBIGUO: rejeitado com UNSUPPORTED_CONSTRUCT (antes virava concatenacao: 10 + '5' = '105')", () => {
      expect(() => translateTsql("SELECT v + '5' FROM p", "postgres")).toThrow(SqlContractError);
      expect(() => translateTsql("SELECT '5' + v FROM p", "postgres")).toThrow(/CONCAT/);
    });
    it("caminhos nao ambiguos: numero + '5' e CAST(coluna AS BIGINT) + '5' somam; LEN(x) + '5' soma", async () => {
      expect(await one("SELECT 1 + '5' AS r")).toBe(6);
      expect(await one("SELECT LEN(nome) + '5' AS r FROM p WHERE id = 1")).toBe(8);
      expect(await one("SELECT CONCAT(v, '5') AS r FROM p WHERE id = 1")).toBe("105");
    });
  });

  // ---- ENT-12: AVG ----
  describe("AVG sobre inteiro", () => {
    it("padrao: media exata (diferenca DOCUMENTADA)", async () => {
      expect(Number(await one("SELECT AVG(v) AS r FROM p WHERE id IN (1, 2, 4)"))).toBeCloseTo(12.3333, 3); // SQL Server: 12 (int)
    });
    it("opcao avgTruncatesIntegers: inteiro trunca como no SQL Server; decimal continua exato", async () => {
      const o = { avgTruncatesIntegers: true };
      expect(Number(await one("SELECT AVG(v) AS r FROM p WHERE id IN (1, 2, 4)", o))).toBe(12);
      expect(Number(await one("SELECT AVG(dec) AS r FROM p WHERE id IN (1, 2)", o))).toBe(2);
      expect(Number(await one("SELECT AVG(v) AS r FROM p WHERE id IN (1, 4)", o))).toBe(8); // (10+7)/2 = 8.5 -> 8
    });
  });

  // ---- ENT-13: colacao alem do LIKE ----
  describe("CHARINDEX / REPLACE ignoram a caixa (collation CI)", () => {
    it("CHARINDEX('A', 'banana') = 2", async () => expect(await one("SELECT CHARINDEX('A', 'banana') AS r")).toBe(2));
    it("CHARINDEX com inicio e vazio", async () => {
      expect(await one("SELECT CHARINDEX('A', 'banana', 3) AS r")).toBe(4);
      expect(await one("SELECT CHARINDEX('', 'banana') AS r")).toBe(0);
      expect(await one("SELECT CHARINDEX('z', 'banana') AS r")).toBe(0);
      expect(await one("SELECT CHARINDEX(nome, 'XANAX') AS r FROM p WHERE id = 1")).toBe(2);
    });
    it("REPLACE('Hello','L','x') = 'Hexxo'", async () => expect(await one("SELECT REPLACE('Hello', 'L', 'x') AS r")).toBe("Hexxo"));
    it("REPLACE com metacaracteres de regex e barra na troca", async () => {
      expect(await one("SELECT REPLACE('a+b A+B', 'A+B', 'X') AS r")).toBe("X X");
      expect(await one("SELECT REPLACE('abc', 'B', '\\') AS r")).toBe("a\\c");
      expect(await one("SELECT REPLACE('a.b.c', '.', '-') AS r")).toBe("a-b-c");
      expect(await one("SELECT REPLACE('abc', '', 'x') AS r")).toBe("abc");
      expect(await one("SELECT REPLACE(nome, 'A', 'o') AS r FROM p WHERE id = 1")).toBe("ono");
    });
    it("REPLACE com coluna como alvo e NULL", async () => {
      expect(await one("SELECT REPLACE(nome, nome, 'k') AS r FROM p WHERE id = 2")).toBe("k");
      expect(await one("SELECT REPLACE(txt, 'a', 'b') AS r FROM p WHERE id = 6")).toBeNull();
    });
  });

  // ---- ENT-14: DATEADD ----
  describe("DATEADD", () => {
    const day = (v: unknown) => (v as Date).toISOString().slice(0, 10);
    it("DATEADD(day, 1.5, d) soma 1 dia (trunca); negativo trunca para zero", async () => {
      expect(day(await one("SELECT DATEADD(day, 1.5, '2026-01-01') AS r"))).toBe("2026-01-02");
      expect(day(await one("SELECT DATEADD(day, -1.5, '2026-01-10') AS r"))).toBe("2026-01-09");
      expect(day(await one("SELECT DATEADD(day, v / 4.0, dia) AS r FROM p WHERE id = 2"))).toBe("2026-02-06"); // 20/4 = 5
    });
    it("DATEADD(quarter, 1, '2026-01-31') = 2026-04-30 (3 meses, ajusta fim de mes)", async () => {
      expect(day(await one("SELECT DATEADD(quarter, 1, '2026-01-31') AS r"))).toBe("2026-04-30");
      expect(day(await one("SELECT DATEADD(qq, -2, '2026-03-15') AS r"))).toBe("2025-09-15");
    });
    it("DATE explicito continua DATE; datetime continua timestamp", async () => {
      const t = async (e: string) => (await client.query(`SELECT pg_typeof(x)::text AS t FROM (${translateTsql(`SELECT ${e} AS x`, "postgres").sql}) q`)).rows[0]!.t;
      expect(await t("DATEADD(day, 1, CAST('2026-01-31' AS DATE))")).toBe("date");
      expect(await t("DATEADD(month, 1, CAST('2026-01-31' AS DATE))")).toBe("date");
      expect(await t("DATEADD(hour, 1, CAST('2026-01-31' AS DATE))")).toBe("timestamp without time zone");
      expect(await t("DATEADD(day, 1, '2026-01-31')")).toBe("timestamp without time zone"); // literal texto -> datetime
    });
  });

  // ---- S1 ----
  describe("S1", () => {
    it("CTE recursivo emite WITH RECURSIVE e roda (soma 1..5 = 15)", async () => {
      expect(await one("WITH c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 5) SELECT SUM(n) AS r FROM c")).toBe("15");
    });
    it("CTE nao recursivo continua sem RECURSIVE", () => {
      expect(translateTsql("WITH c AS (SELECT 1 AS a) SELECT a FROM c", "postgres").sql).not.toMatch(/RECURSIVE/);
    });
    it("COUNT_BIG(*) = COUNT(*)", async () => expect(await one("SELECT COUNT_BIG(*) AS r FROM p")).toBe("7"));
    it("REPLICATE / SPACE", async () => {
      expect(await one("SELECT REPLICATE('ab', 3) AS r")).toBe("ababab");
      expect(await one("SELECT REPLICATE('ab', -1) AS r")).toBeNull();
      expect(await one("SELECT REPLICATE('ab', 0) AS r")).toBe("");
      expect(await one("SELECT SPACE(3) + 'x' AS r")).toBe("   x");
      expect(await one("SELECT REPLICATE('a', 2) + 'z' AS r")).toBe("aaz");
    });
    it("EOMONTH e DATEFROMPARTS", async () => {
      const day = (v: unknown) => (v as Date).toISOString().slice(0, 10);
      expect(day(await one("SELECT EOMONTH('2026-02-15') AS r"))).toBe("2026-02-28");
      expect(day(await one("SELECT EOMONTH('2024-02-15') AS r"))).toBe("2024-02-29");
      expect(day(await one("SELECT EOMONTH('2026-01-31', 1) AS r"))).toBe("2026-02-28");
      expect(day(await one("SELECT EOMONTH(dia) AS r FROM p WHERE id = 1"))).toBe("2026-01-31");
      expect(day(await one("SELECT DATEFROMPARTS(2026, 2, 28) AS r"))).toBe("2026-02-28");
    });
    it.each([
      "SELECT FORMAT(dia, 'yyyy') FROM p", "SELECT DATENAME(month, dia) FROM p", "SELECT ISNUMERIC(txt) FROM p",
      "SELECT * FROM STRING_SPLIT('a,b', ',')", "SELECT a FROM p CROSS APPLY STRING_SPLIT(nome, ',')", "SELECT PATINDEX('%a%', nome) FROM p",
      "SELECT STUFF(nome, 1, 1, 'x') FROM p", "SELECT CHOOSE(1, 'a', 'b')", "SELECT DATETRUNC(month, dia) FROM p",
    ])("funcao sem equivalente exato: %s -> UNSUPPORTED_CONSTRUCT (nunca erro cru do banco)", (q) => {
      try { translateTsql(q, "postgres"); throw new Error("nao rejeitou"); } catch (e) {
        expect(e).toBeInstanceOf(SqlContractError);
        expect((e as SqlContractError).code).toBe("UNSUPPORTED_CONSTRUCT");
      }
    });
    it("NATURAL JOIN e rejeitado (nao existe em T-SQL; antes virava um alias 'natural')", () => {
      expect(() => translateTsql("SELECT a FROM p NATURAL JOIN p q", "postgres")).toThrow(SqlContractError);
    });
    it("TOP em ramo de UNION vale so para o ramo (e ORDER BY final vale para a uniao)", async () => {
      expect((await run("SELECT TOP 2 id FROM p UNION ALL SELECT id FROM p")).length).toBe(9);          // 2 + 7
      expect((await run("SELECT id FROM p UNION ALL SELECT TOP 1 id FROM p ORDER BY id")).length).toBe(8); // 7 + 1
      expect((await run("SELECT id FROM p WHERE id < 3 UNION SELECT TOP 2 id FROM p")).length).toBeGreaterThanOrEqual(2);
      const ordered = (await run("SELECT TOP 2 id FROM p UNION ALL SELECT TOP 3 id FROM p ORDER BY id DESC")).map((x) => x.id);
      expect(ordered.length).toBe(5);
      expect(ordered).toEqual([...ordered].sort((a, b) => (b as number) - (a as number)));
    });
    it("LIKE ... ESCAPE e rejeitado com mensagem clara", () => {
      expect(() => translateTsql("SELECT 1 FROM p WHERE nome LIKE 'a!%' ESCAPE '!'", "postgres")).toThrow(/ESCAPE/);
    });
  });
});
