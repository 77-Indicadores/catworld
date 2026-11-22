import { beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";

/**
 * Consultas de ERP do tipo "SELECT a.*, b.*" repetem nomes de coluna. Antes a sondagem embrulhava a consulta numa
 * tabela derivada (Firebird recusa: "Column X was specified multiple times for derived table") e a leitura em
 * objeto deixava a 2a coluna sobrescrever a 1a. Aqui o driver e simulado com o formato real do node-firebird
 * (statement preparado com `output`, queryStream com asObject:false entregando arrays).
 */
const SQL_VARYING = 448;
const SQL_LONG = 496;
const output = [
  { type: SQL_LONG, alias: "EQ_CDG", field: "EQ_CDG", nullable: false, length: 4, scale: 0 },
  { type: SQL_VARYING, alias: "EQ_PLACA", field: "EQ_PLACA", nullable: true, length: 40, nativeLength: 10, scale: 0, subType: 0 },
  { type: SQL_VARYING, alias: "EQ_PLACA", field: "EQ_PLACA", nullable: true, length: 40, nativeLength: 10, scale: 0, subType: 0 },
  { type: SQL_VARYING, alias: "eq_placa_2", field: "EQ_PLACA_2", nullable: true, length: 40, nativeLength: 10, scale: 0, subType: 0 },
];
const db = {
  newStatementAsync: vi.fn(async () => ({ output, release: vi.fn() })),
  queryAsync: vi.fn(),
  queryStream: vi.fn(() => Readable.from([[1, "ABC1234", "XYZ9876", "QQQ0000"]], { objectMode: true })),
  detachAsync: vi.fn(async () => undefined),
};
vi.mock("node-firebird", () => ({ attachAsync: vi.fn(async () => db) }));

const { queryColumnsFirebird, streamFirebirdRows, uniqueFirebirdColumnNames } = await import("./firebird");
const endpoint = { host: "h", port: 3050, database: "/x.fdb", user: "sysdba", password: "p" };

beforeEach(() => { db.queryAsync.mockReset(); });

describe("colunas repetidas em consulta Firebird", () => {
  it("renomeia so as repetidas (_2, _3) sem colidir com uma coluna que ja se chama assim", () => {
    expect(uniqueFirebirdColumnNames(["A", "B", "A", "A"])).toEqual(["A", "B", "A_2", "A_3"]);
    expect(uniqueFirebirdColumnNames(["A", "A_2", "A"])).toEqual(["A", "A_2", "A_3"]);
    expect(uniqueFirebirdColumnNames(["A", "A", "a_2"])).toEqual(["A", "A_3", "a_2"]);
  });

  it("sonda preparando o statement, sem embrulhar numa tabela derivada", async () => {
    const cols = await queryColumnsFirebird(endpoint, "SELECT e.*, t.* FROM EQUIP e JOIN TRANSP t ON t.EQ = e.EQ_CDG");
    expect(db.queryAsync).not.toHaveBeenCalled();
    expect(db.newStatementAsync).toHaveBeenCalledWith("SELECT e.*, t.* FROM EQUIP e JOIN TRANSP t ON t.EQ = e.EQ_CDG");
    expect(cols.map((c) => c.originalName)).toEqual(["EQ_CDG", "EQ_PLACA", "EQ_PLACA_3", "eq_placa_2"]);
    expect(new Set(cols.map((c) => c.sqlName)).size).toBe(4);
    expect(cols[1]!.sqlType).toBe("NVARCHAR(10)");
  });

  it("le as linhas por posicao: as duas colunas de mesmo nome chegam com seus proprios valores", async () => {
    const batches = [];
    for await (const b of streamFirebirdRows(endpoint, "SELECT e.*, t.* FROM EQUIP e JOIN TRANSP t ON t.EQ = e.EQ_CDG")) batches.push(...b);
    expect(db.queryStream).toHaveBeenCalledWith(expect.any(String), [], { asObject: false });
    expect(batches).toEqual([{ EQ_CDG: 1, EQ_PLACA: "ABC1234", EQ_PLACA_3: "XYZ9876", eq_placa_2: "QQQ0000" }]);
  });
});
