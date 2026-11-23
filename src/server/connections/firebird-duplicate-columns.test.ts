import { beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";

/**
 * Consultas de ERP do tipo "SELECT a.*, b.*" repetem nomes de coluna. Antes a sondagem embrulhava a consulta numa
 * tabela derivada (Firebird recusa: "Column X was specified multiple times for derived table") e a leitura em
 * objeto deixava a 2a coluna sobrescrever a 1a. Aqui o driver e simulado com o formato real do node-firebird
 * (transacao com statement preparado e `output`; linhas em array com asObject:false). O comportamento contra um
 * Firebird de verdade esta em firebird.test.ts (gated por env).
 */
const SQL_VARYING = 448;
const SQL_LONG = 496;
const SQL_BLOB = 520;
let output: Array<Record<string, unknown>> = [];
const drop = vi.fn(async () => undefined);
const tx = {
  newStatementAsync: vi.fn(async () => ({ output, dropAsync: drop })),
  queryAsync: vi.fn(async (): Promise<unknown[][]> => []),
  rollbackAsync: vi.fn(async () => undefined),
};
const db = {
  transactionAsync: vi.fn(async () => tx),
  queryAsync: vi.fn(),
  queryStream: vi.fn(() => Readable.from([[1, "ABC1234", "XYZ9876", "QQQ0000"]], { objectMode: true })),
  detachAsync: vi.fn(async () => undefined),
};
vi.mock("node-firebird", () => ({ attachAsync: vi.fn(async () => db), ISOLATION_READ_COMMITTED_READ_ONLY: [1], ISOLATION_READ_COMMITTED: [2] }));

const { queryColumnsFirebird, streamFirebirdRows, uniqueFirebirdColumnNames } = await import("./firebird");
const endpoint = { host: "h", port: 3050, database: "/x.fdb", user: "sysdba", password: "p" };
const SQL = "SELECT e.*, t.* FROM EQUIP e JOIN TRANSP t ON t.EQ = e.EQ_CDG";

beforeEach(() => {
  vi.clearAllMocks();
  output = [
    { type: SQL_LONG, alias: "EQ_CDG", field: "EQ_CDG", nullable: false, length: 4, scale: 0 },
    { type: SQL_VARYING, alias: "EQ_PLACA", field: "EQ_PLACA", nullable: true, length: 40, nativeLength: 10, scale: 0, subType: 0 },
    { type: SQL_VARYING, alias: "EQ_PLACA", field: "EQ_PLACA", nullable: true, length: 40, nativeLength: 10, scale: 0, subType: 0 },
    { type: SQL_VARYING, alias: "eq_placa_2", field: "EQ_PLACA_2", nullable: true, length: 40, nativeLength: 10, scale: 0, subType: 0 },
  ];
});

describe("colunas repetidas em consulta Firebird", () => {
  it("renomeia so as repetidas (_2, _3) sem colidir com uma coluna que ja se chama assim", () => {
    expect(uniqueFirebirdColumnNames(["A", "B", "A", "A"])).toEqual(["A", "B", "A_2", "A_3"]);
    expect(uniqueFirebirdColumnNames(["A", "A_2", "A"])).toEqual(["A", "A_2", "A_3"]);
    expect(uniqueFirebirdColumnNames(["A", "A", "a_2"])).toEqual(["A", "A_3", "a_2"]);
  });

  it("sonda preparando o statement numa transacao propria, com DROP (nao release ao cache) e rollback", async () => {
    const cols = await queryColumnsFirebird(endpoint, SQL);
    expect(db.queryAsync).not.toHaveBeenCalled();
    expect(tx.newStatementAsync).toHaveBeenCalledWith(SQL);
    expect(drop).toHaveBeenCalledTimes(1);
    expect(tx.rollbackAsync).toHaveBeenCalledTimes(1);
    expect(cols.map((c) => c.originalName)).toEqual(["EQ_CDG", "EQ_PLACA", "EQ_PLACA_3", "eq_placa_2"]);
    expect(new Set(cols.map((c) => c.sqlName)).size).toBe(4);
    expect(cols[0]!.sqlType).toBe("BIGINT");
    expect(cols[1]!.sqlType).toBe("NVARCHAR(MAX)");
  });

  it("sem BLOB: le em streaming por posicao, as duas colunas de mesmo nome com seus proprios valores", async () => {
    const rows = [];
    for await (const b of streamFirebirdRows(endpoint, SQL)) rows.push(...b);
    expect(db.queryStream).toHaveBeenCalledWith(SQL, [], { asObject: false });
    expect(rows).toEqual([{ EQ_CDG: 1, EQ_PLACA: "ABC1234", EQ_PLACA_3: "XYZ9876", eq_placa_2: "QQQ0000" }]);
  });

  it("com BLOB: nao usa streaming (driver trava/da 'Invalid BLOB ID'), le tudo e repassa em lotes; binario vira nulo", async () => {
    output = [
      { type: SQL_LONG, alias: "ID", field: "ID", nullable: false, length: 4, scale: 0 },
      { type: SQL_BLOB + 1, alias: "OBS", field: "OBS", nullable: true, length: 8, scale: 0, subType: 1 },
      { type: SQL_BLOB + 1, alias: "FOTO", field: "FOTO", nullable: true, length: 8, scale: 0, subType: 0 },
    ];
    tx.queryAsync.mockResolvedValueOnce([[1, "texto", () => undefined], [2, null, null], [3, "outro", () => undefined]]);
    const batches = [];
    for await (const b of streamFirebirdRows(endpoint, "SELECT ID, OBS, FOTO FROM T", 2)) batches.push(b);
    expect(db.queryStream).not.toHaveBeenCalled();
    expect(tx.queryAsync).toHaveBeenCalledWith("SELECT ID, OBS, FOTO FROM T", [], { asObject: false });
    expect(batches).toEqual([
      [{ ID: 1, OBS: "texto", FOTO: null }, { ID: 2, OBS: null, FOTO: null }],
      [{ ID: 3, OBS: "outro", FOTO: null }],
    ]);
  });
  it("so tipos canonicos do storage (BIGINT/DECIMAL/DATE/DATETIME2/TIME/NVARCHAR(MAX)): INT, FLOAT ou NVARCHAR(n) viravam TEXT fisico", async () => {
    output = [
      { type: 500, alias: "S", field: "S", nullable: true, length: 2, scale: 0 },
      { type: SQL_LONG, alias: "L", field: "L", nullable: true, length: 4, scale: 0 },
      { type: 580, alias: "I64", field: "I64", nullable: true, length: 8, scale: 0 },
      { type: SQL_LONG, alias: "NUM", field: "NUM", nullable: true, length: 4, scale: -2 },
      { type: 480, alias: "DBL", field: "DBL", nullable: true, length: 8, scale: 0 },
      { type: 570, alias: "DT", field: "DT", nullable: true, length: 4, scale: 0 },
      { type: 510, alias: "TS", field: "TS", nullable: true, length: 8, scale: 0 },
      { type: SQL_VARYING, alias: "V", field: "V", nullable: true, length: 40, scale: 0, subType: 0 },
      { type: 32764, alias: "B", field: "B", nullable: true, length: 1, scale: 0 },
      { type: SQL_BLOB, alias: "BL", field: "BL", nullable: true, length: 8, scale: 0, subType: 0 },
    ];
    const cols = await queryColumnsFirebird(endpoint, "SELECT * FROM T");
    expect(cols.map((c) => c.sqlType)).toEqual([
      "BIGINT", "BIGINT", "BIGINT", "DECIMAL(9,2)", "NVARCHAR(MAX)", "DATE", "DATETIME2", "NVARCHAR(MAX)", "NVARCHAR(MAX)", "NVARCHAR(MAX)",
    ]);
    expect(cols[4]!.lossyNumeric).toBe(true);
  });
});
