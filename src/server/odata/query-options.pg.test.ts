/** $filter/$orderby traduzidos e EXECUTADOS em Postgres real. So roda com CW_TEST_PG_URL (descartavel — NUNCA producao). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { translateFilter, translateOrderBy, type ODataColumn } from "./query-options";

const url = process.env.CW_TEST_PG_URL;
const d = url ? describe : describe.skip;

d("odata query-options (executando)", () => {
  const pool = new Pool({ connectionString: url });
  const cols: ODataColumn[] = [
    { sqlName: "id", sqlType: "BIGINT" }, { sqlName: "nome", sqlType: "NVARCHAR(MAX)" }, { sqlName: "valor", sqlType: "DECIMAL(18,4)" },
    { sqlName: "dia", sqlType: "DATE" }, { sqlName: "dt", sqlType: "DATETIME2" }, { sqlName: "ativo", sqlType: "BIT" },
  ];
  const ref = (c: { sqlName: string }) => `"${c.sqlName}"`;
  const ids = async (filter?: string, orderby?: string) => {
    const w = filter ? ` WHERE ${translateFilter(filter, cols, ref)}` : "";
    const o = orderby ? ` ORDER BY ${translateOrderBy(orderby, cols, ref)}` : " ORDER BY id";
    const r = await pool.query(`SELECT id FROM od.t${w}${o}`);
    return r.rows.map((x) => Number(x.id));
  };

  beforeAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS od CASCADE; CREATE SCHEMA od;
      CREATE TABLE od.t (id bigint, nome text, valor numeric(18,4), dia date, dt timestamp, ativo boolean);
      INSERT INTO od.t VALUES
        (1,'ana',10.5,'2026-01-31','2026-01-31 10:00:00',true),
        (2,'Bia',20,'2026-02-01','2026-02-01 00:01:00',false),
        (3,'cai',NULL,'2026-03-15','2026-03-15 10:30:45',NULL),
        (4,'o''brien 50%',5.25,NULL,NULL,true),
        (5,NULL,1,'2027-01-01','2027-01-01 00:00:00',false)`);
  });
  afterAll(async () => { await pool.query("DROP SCHEMA IF EXISTS od CASCADE"); await pool.end(); });

  it("comparacoes e logica", async () => {
    expect(await ids("id eq 1")).toEqual([1]);
    expect(await ids("id ne 1 and id lt 4")).toEqual([2, 3]);
    expect(await ids("id eq 1 or id eq 5")).toEqual([1, 5]);
    expect(await ids("not (id lt 4)")).toEqual([4, 5]);
    expect(await ids("valor ge 10 and valor le 20")).toEqual([1, 2]);
    expect(await ids("ativo eq true")).toEqual([1, 4]);
  });
  it("null (IS NULL) — comparar com = NULL nunca acharia nada", async () => {
    expect(await ids("nome eq null")).toEqual([5]);
    expect(await ids("valor ne null")).toEqual([1, 2, 4, 5]);
  });
  it("ENT-07 nulos: ne e not INCLUEM as linhas com valor nulo (OData v4), eq/gt nao", async () => {
    expect(await ids("valor ne 20")).toEqual([1, 3, 4, 5]);          // 3 tem valor NULL
    expect(await ids("not (valor eq 20)")).toEqual([1, 3, 4, 5]);
    expect(await ids("nome ne 'ana'")).toEqual([2, 3, 4, 5]);        // 5 tem nome NULL
    expect(await ids("not (valor gt 5)")).toEqual([3, 5]);           // NULL gt 5 e falso, logo not = verdadeiro (ids 3 e 5)
    expect(await ids("valor gt 5")).toEqual([1, 2, 4]);
    expect(await ids("not (nome eq 'ana' or valor eq 20)")).toEqual([3, 4, 5]);
    expect(await ids("year(dia) ne 2026")).toEqual([4, 5]);         // dia NULL (id 4) entra
  });
  it("texto: eq, contains/startswith/endswith e curingas literais (%) sem vazar", async () => {
    expect(await ids("nome eq 'ana'")).toEqual([1]);
    expect(await ids("contains(nome,'a')")).toEqual([1, 2, 3]);   // ana, Bia, cai
    expect(await ids("startswith(nome,'B')")).toEqual([2]);
    expect(await ids("endswith(nome,'0%')")).toEqual([4]);
    expect(await ids("contains(nome,'%')")).toEqual([4]);   // % e literal, nao curinga
    expect(await ids("nome eq 'o''brien 50%'")).toEqual([4]);
  });
  it("datas, datetimes e year/month", async () => {
    expect(await ids("dia ge 2026-02-01 and dia lt 2027-01-01")).toEqual([2, 3]);
    expect(await ids("dt gt 2026-02-01T00:00:00Z")).toEqual([2, 3, 5]);
    expect(await ids("dt ge 2026-03-15")).toEqual([3, 5]);         // datetime x date
    expect(await ids("year(dia) eq 2026")).toEqual([1, 2, 3]);
    expect(await ids("month(dia) eq 1")).toEqual([1, 5]);
  });
  it("tentativa de injecao nao muda nada nem quebra o SQL", async () => {
    expect(await ids(`nome eq 'x'' OR ''1''=''1'`)).toEqual([]);
    expect(() => translateFilter("id eq 1; DROP TABLE od.t", cols, ref)).toThrow();
    expect((await pool.query("SELECT count(*)::int AS n FROM od.t")).rows[0].n).toBe(5);
  });
  it("$orderby: NULL e o MENOR valor (OData v4): primeiro em asc, ultimo em desc", async () => {
    const asc = (await pool.query(`SELECT id FROM od.t ORDER BY ${translateOrderBy("valor", cols, ref)}`)).rows.map((x) => Number(x.id));
    expect(asc[0]).toBe(3); // valor NULL primeiro
    const desc = (await pool.query(`SELECT id FROM od.t ORDER BY ${translateOrderBy("valor desc", cols, ref)}`)).rows.map((x) => Number(x.id));
    expect(desc.at(-1)).toBe(3); // valor NULL por ultimo
    expect(desc.slice(0, 2)).toEqual([2, 1]);
  });
  it("filtro + ordenacao juntos", async () => {
    expect(await ids("valor gt 1", "valor desc")).toEqual([2, 1, 4]);
  });
});
