import { describe, expect, it } from "vitest";
import { validateReadOnlySql } from "./sql-safety";

const blocked = (sql: string) => {
  const r = validateReadOnlySql(sql);
  return r.safe ? null : r.reason;
};

describe("validateReadOnlySql — o que barra", () => {
  it.each([
    ["SELECT INTO cria tabela", "SELECT * INTO nova FROM vendas"],
    ["INTO no meio de CTE", "WITH a AS (SELECT 1 AS x) SELECT * INTO t2 FROM a"],
    ["pg_sleep", "SELECT pg_sleep(600)"],
    ["pg_read_file", "SELECT pg_read_file('/etc/passwd')"],
    ["pg_ls_dir (familia)", "SELECT pg_ls_dir('.')"],
    ["lo_import", "SELECT lo_import('/etc/passwd')"],
    ["dblink", "SELECT * FROM dblink('host=x','select 1') AS t(a int)"],
    ["dblink_exec (familia)", "SELECT dblink_exec('x','drop table t')"],
    ["nextval", "SELECT nextval('seq')"],
    ["set_config", "SELECT set_config('search_path','x',false)"],
    ["pg_terminate_backend", "SELECT pg_terminate_backend(1)"],
    ["pg_advisory_lock (familia)", "SELECT pg_advisory_lock(1)"],
    ["OPENROWSET", "SELECT * FROM OPENROWSET('SQLNCLI','Server=x;','SELECT 1')"],
    ["OPENQUERY", "SELECT * FROM OPENQUERY(srv, 'SELECT 1')"],
    ["WAITFOR", "WITH a AS (SELECT 1 AS x) SELECT * FROM a WAITFOR DELAY '00:10'"],
    ["caixa mista", "SeLeCt PG_ReAd_FiLe('/x')"],
    ["dois statements", "SELECT 1; SELECT 2"],
    ["DELETE em CTE", "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d"],
    ["nao comeca em SELECT/WITH", "EXPLAIN SELECT 1"],
  ])("%s", (_l, sql) => {
    expect(blocked(sql), sql).not.toBeNull();
  });
});

describe("validateReadOnlySql — o que NAO pode barrar (falsos positivos)", () => {
  it.each([
    ["consulta comum", "SELECT TOP 10 a, b FROM vendas WHERE c > 1 ORDER BY a"],
    ["coluna com nome parecido", "SELECT created_at, into_date, printing, update_count FROM t"],
    ["palavra perigosa em string", "SELECT * FROM t WHERE obs = 'pg_sleep into waitfor nextval'"],
    ["palavra perigosa em comentario", "SELECT 1 -- INTO x\n/* pg_sleep(9) */"],
    ["identificador entre aspas", 'SELECT "update", "into" FROM t'],
    ["identificador entre colchetes nao vira comando", "SELECT [nome] FROM [vendas]"],
    ["CTE + JOIN + janela", "WITH a AS (SELECT id, ROW_NUMBER() OVER (ORDER BY id) rn FROM t) SELECT * FROM a JOIN b ON a.id = b.id"],
    ["funcoes comuns", "SELECT COALESCE(a,0), UPPER(b), DATEDIFF(day,c,d), CAST(x AS INT) FROM t"],
    ["tabela sp_", "SELECT * FROM sp_vendas"],
  ])("%s", (_l, sql) => {
    expect(blocked(sql), sql).toBeNull();
  });
});

// Casos originais do teste (versao inicial), mantidos integralmente.
describe("SQL safety (casos originais)", () => {
  it.each(["SELECT 1", "WITH x AS (SELECT 1 a) SELECT * FROM x", "SELECT 'DROP TABLE x' value", "/* DROP TABLE x */ SELECT 1"])(
    "aceita leitura: %s",
    (sql) => expect(validateReadOnlySql(sql).safe).toBe(true),
  );
  it.each(["DROP TABLE x", "SELECT 1; DROP TABLE x", "UPDATE x SET y=1", "EXEC sp_who"])(
    "bloqueia escrita: %s",
    (sql) => expect(validateReadOnlySql(sql).safe).toBe(false),
  );
});
