import { describe, expect, it } from "vitest";
import { hideDeletedRows, type HideDeletedCtx, type TableState } from "./hide-deleted";

// ds.vendas / ds.itens / other.vendas tem cw_deleted_at; ds.clientes nao tem; ds.Mixed tem (caixa mista)
const STATE: Record<string, TableState> = {
  "ds.vendas": "deleted", "ds.itens": "deleted", "other.vendas": "deleted", "ds.clientes": "plain", "ds.Mixed": "deleted",
  "ds.u v": "deleted", "a.dup": "deleted", "b.dup": "plain",
};
const make = (schemas = ["ds"]) => {
  const skips: string[] = [];
  const looked: string[] = [];
  const ctx: HideDeletedCtx = {
    schemas,
    lookup: async (s, t) => { looked.push(`${s}.${t}`); return STATE[`${s}.${t}`] ?? "missing"; },
    onSkip: (r) => skips.push(r),
  };
  return { ctx, skips, looked };
};
const F = (s: string, t: string, alias?: string) => `(SELECT * FROM ${s}.${t} WHERE cw_deleted_at IS NULL) AS ${alias ?? t}`;
const run = async (sql: string, schemas?: string[]) => {
  const m = make(schemas);
  return { ...(await hideDeletedRows(sql, m.ctx)), skips: m.skips, looked: m.looked };
};
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

describe("hideDeletedRows", () => {
  it("reescreve FROM com alias, mantendo o alias", async () => {
    const r = await run("SELECT v.id FROM ds.vendas v");
    expect(r.rewritten).toBe(1);
    expect(norm(r.sql)).toBe(`SELECT v.id FROM ${F("ds", "vendas", "v")}`);
  });

  it("sem alias usa o nome da tabela (t.col continua valendo)", async () => {
    const r = await run("SELECT vendas.id FROM ds.vendas WHERE vendas.id > 1");
    expect(norm(r.sql)).toBe(`SELECT vendas.id FROM ${F("ds", "vendas")} WHERE vendas.id > 1`);
  });

  it("JOIN, self-join e virgula", async () => {
    const r = await run("SELECT * FROM ds.itens, ds.vendas a INNER JOIN ds.vendas b ON a.id = b.pai LEFT JOIN ds.clientes c ON c.id = a.c");
    expect(r.rewritten).toBe(3);
    expect(norm(r.sql)).toContain(`FROM ${F("ds", "itens")}, ${F("ds", "vendas", "a")} INNER JOIN ${F("ds", "vendas", "b")} ON a.id = b.pai LEFT JOIN ds.clientes AS c ON c.id = a.c`);
  });

  it("subconsulta, EXISTS, IN e tabela derivada", async () => {
    const r = await run("SELECT * FROM (SELECT id FROM ds.vendas) x WHERE x.id IN (SELECT id FROM ds.itens) AND EXISTS (SELECT 1 FROM ds.vendas z WHERE z.id = x.id)");
    expect(r.rewritten).toBe(3);
    expect(norm(r.sql)).toContain(F("ds", "itens"));
    expect(norm(r.sql)).toContain(F("ds", "vendas", "z"));
  });

  it("corpo de CTE e ramos de UNION", async () => {
    const r = await run("WITH c AS (SELECT id FROM ds.vendas) SELECT id FROM c UNION ALL SELECT id FROM ds.itens UNION SELECT id FROM ds.clientes");
    expect(r.rewritten).toBe(2);
    expect(norm(r.sql)).toContain(`WITH c AS (SELECT id FROM ${F("ds", "vendas")}) SELECT id FROM c UNION ALL SELECT id FROM ${F("ds", "itens")} UNION SELECT id FROM ds.clientes`);
  });

  it("nome de CTE nao e reescrito (sombra de tabela sem schema)", async () => {
    const r = await run("WITH vendas AS (SELECT 1 id) SELECT * FROM vendas");
    expect(r.rewritten).toBe(0);
    expect(r.sql).toBe("WITH vendas AS (SELECT 1 id) SELECT * FROM vendas");
    expect(r.looked).toEqual([]);
  });

  it("CTE com o mesmo nome nao afeta a referencia com schema", async () => {
    const r = await run("WITH vendas AS (SELECT 1 id) SELECT * FROM vendas UNION ALL SELECT id FROM ds.vendas");
    expect(r.rewritten).toBe(1);
    expect(norm(r.sql)).toContain(`FROM vendas UNION ALL SELECT id FROM ${F("ds", "vendas")}`);
  });

  it("tabela sem schema resolve no escopo", async () => {
    const r = await run("SELECT * FROM vendas", ["ds"]);
    expect(norm(r.sql)).toBe(`SELECT * FROM ${F("ds", "vendas")}`);
  });

  it("sem schema e ambiguo entre schemas do escopo: nao mexe", async () => {
    const r = await run("SELECT * FROM vendas", ["ds", "other"]);
    expect(r.rewritten).toBe(0);
  });

  it("sem schema, existente so em um schema do escopo com varios", async () => {
    const r = await run("SELECT * FROM clientes JOIN itens ON 1=1", ["ds", "other"]);
    expect(r.rewritten).toBe(1);
    expect(norm(r.sql)).toContain(F("ds", "itens"));
  });

  it("no-op byte a byte para tabelas sem a coluna, inexistentes e sem FROM", async () => {
    for (const sql of [
      "SELECT  *  FROM ds.clientes   c WHERE c.id=1 -- x",
      "SELECT * FROM ds.naoexiste",
      "SELECT 1 AS um",
      "SELECT TOP 3 [a b] FROM [ds].[clientes] ORDER BY 1",
    ]) {
      const r = await run(sql);
      expect(r.rewritten).toBe(0);
      expect(r.sql).toBe(sql);
      expect(r.skips).toEqual([]);
    }
  });

  it("identificadores com colchetes preservam caixa e espacos", async () => {
    const r = await run("SELECT [Mixed].[Nome Col] FROM [ds].[Mixed]");
    expect(norm(r.sql)).toBe("SELECT [Mixed].[Nome Col] FROM (SELECT * FROM [ds].[Mixed] WHERE cw_deleted_at IS NULL) AS [Mixed]");
    const r2 = await run("SELECT x.a FROM ds.[u v] x");
    expect(norm(r2.sql)).toBe("SELECT x.a FROM (SELECT * FROM ds.[u v] WHERE cw_deleted_at IS NULL) AS x");
  });

  it("sem colchetes, a caixa e minuscula primeiro (contrato dobra para minusculo)", async () => {
    const r = await run("SELECT * FROM DS.Vendas");
    expect(r.rewritten).toBe(1);
    expect(norm(r.sql)).toContain("FROM ds.vendas WHERE");
  });

  it("DISTINCT, GROUP BY, TOP, ORDER BY e OFFSET/FETCH continuam", async () => {
    const r = await run("SELECT DISTINCT TOP 5 v.cliente, COUNT(*) AS n FROM ds.vendas v GROUP BY v.cliente HAVING COUNT(*) > 1 ORDER BY n DESC");
    expect(norm(r.sql)).toBe(`SELECT DISTINCT TOP 5 v.cliente, COUNT(*) AS n FROM ${F("ds", "vendas", "v")} GROUP BY v.cliente HAVING COUNT(*) > 1 ORDER BY n DESC`);
    const p = await run("SELECT id FROM ds.vendas ORDER BY id OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY");
    expect(norm(p.sql)).toContain("ORDER BY id ASC OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY");
  });

  it("SELECT * e NOLOCK", async () => {
    const r = await run("SELECT * FROM ds.vendas WITH (NOLOCK)");
    expect(norm(r.sql)).toContain("FROM ds.vendas WITH (NOLOCK) WHERE cw_deleted_at IS NULL) AS vendas");
  });

  it("literais com [ ] ou cw_deleted_at nao sao tocados", async () => {
    const r = await run("SELECT '[x] FROM ds.vendas' AS s FROM ds.vendas");
    expect(norm(r.sql)).toBe(`SELECT '[x] FROM ds.vendas' AS s FROM ${F("ds", "vendas")}`);
  });

  it("nao mexe em 3 partes, #temp e funcao de tabela", async () => {
    const r = await run("SELECT * FROM db1.ds.vendas JOIN #tmp ON 1=1");
    expect(r.rewritten).toBe(0);
  });

  it("SQL que o parser nao le (ou ambiguo): devolve o original, conta o skip e nao lanca", async () => {
    const pg = "SELECT id::int FROM ds.vendas";
    const r = await run(pg);
    expect(r.sql).toBe(pg);
    expect(r.rewritten).toBe(0);
    expect(r.skipped).toBe(true);
    expect(r.skips).toHaveLength(1);
    const comma = await run("SELECT * FROM ds.clientes c JOIN ds.clientes d ON c.id = d.id, ds.vendas");
    expect(comma.skipped).toBe(true);
    expect(comma.sql).toContain("ds.vendas");
  });

  it("coluna de 3 partes schema.tabela.coluna perde o prefixo do schema", async () => {
    const r = await run("SELECT ds.vendas.id FROM ds.vendas WHERE ds.vendas.x = 1");
    expect(norm(r.sql)).toBe(`SELECT vendas.id FROM ${F("ds", "vendas")} WHERE vendas.x = 1`);
  });

  it("lookup uma vez por tabela distinta", async () => {
    const r = await run("SELECT * FROM ds.vendas a JOIN ds.vendas b ON 1=1 JOIN ds.vendas c ON 1=1");
    expect(r.rewritten).toBe(3);
    expect(r.looked.filter((x) => x === "ds.vendas")).toHaveLength(1);
  });
});
