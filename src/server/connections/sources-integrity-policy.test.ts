import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  datasetSource: { findUnique: vi.fn(), findMany: vi.fn(), findUniqueOrThrow: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
  datasetColumn: { deleteMany: vi.fn(), createMany: vi.fn() },
  datasetTable: { update: vi.fn() },
  datasetVersion: { create: vi.fn() },
  job: { findMany: vi.fn(), create: vi.fn() },
  $transaction: vi.fn(async (ops: unknown[]) => ops),
  $queryRawUnsafe: vi.fn(),
  $executeRawUnsafe: vi.fn(),
  $executeRaw: vi.fn(async () => 1),
}));
const storage = vi.hoisted(() => ({
  createSchemaIfNotExists: vi.fn(), dropTableIfExists: vi.fn(), createTable: vi.fn(), bulkInsert: vi.fn(), query: vi.fn(),
  q: (s: string) => `"${s}"`, tableExists: vi.fn(), atomicSwap: vi.fn(), countRows: vi.fn(), serverNow: vi.fn(), countMissingKeys: vi.fn(),
}));
const streams = vi.hoisted(() => ({ rows: vi.fn() }));

vi.mock("@/server/db", () => ({ prisma: prismaMock }));
vi.mock("@/server/db/advisory-lock", () => ({ withAdvisoryLock: (_k: string, fn: () => unknown) => fn() }));
vi.mock("@/server/azure/sql", () => ({ sqlPool: vi.fn(), ensureSchema: vi.fn() }));
vi.mock("@/server/storage/connection", () => ({ getStorageConnection: vi.fn(async () => storage) }));
vi.mock("./postgres", () => ({
  queryColumns: vi.fn(async () => [{ originalName: "Id", sqlName: "id", sqlType: "BIGINT", nullable: false }]), quotedPgTable: (s: string, t: string) => `"${s}"."${t}"`,
  streamPostgresRows: (_c: unknown, q: string) => streams.rows(q),
  sourceClockPg: vi.fn(async () => new Date("2026-01-02T00:00:00Z")),
  tableColumns: vi.fn(async () => [{ originalName: "Id", sqlName: "id", sqlType: "BIGINT", nullable: false }]),
}));
vi.mock("./mssql", () => ({ sourceClockMssql: vi.fn(), queryColumnsMssql: vi.fn(), quotedMssqlTable: vi.fn(), streamMssqlRows: vi.fn(), tableColumnsMssql: vi.fn() }));

import { refreshDatasetSource } from "./sources";
import { effectiveIntegrity, parseOptions } from "./source-options";
import { evaluateLoad, INTEGRITY_DEFAULTS } from "@/server/integrity/policy";

const ID = "22222222-2222-2222-2222-222222222222";
const base = (over: Record<string, unknown> = {}) => ({
  id: ID, active: true, mode: "extract", sourceKind: "table", sourceSchema: "public", sourceTable: "t", deltaColumn: null,
  lastDeltaValue: null, keyColumn: null, refreshCron: "0 * * * *", reconciliationCron: null, sourceSql: null,
  sourceSqlReconciliation: null, detectDeletions: false, keysSql: null, keysMinIntervalMinutes: null, lastKeysCheckAt: null, lastError: null,
  lastRowCount: 1000n, datasetId: "ds1",
  dataset: { storageServerId: null, schemaName: "ds" }, connection: { provider: "postgres" }, targetTable: { id: "tt", sqlName: "t" }, ...over,
});
async function* nRows(n: number) { yield Array.from({ length: n }, (_, i) => ({ Id: i + 1 })); }
async function* empty() { /* origem vazia */ }
function setup(source: Record<string, unknown>, rows: () => AsyncGenerator<unknown[]>, prev = 1000) {
  prismaMock.datasetSource.findUnique.mockResolvedValue(source);
  prismaMock.datasetSource.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.job.findMany.mockResolvedValue([]);
  prismaMock.job.create.mockResolvedValue({ id: "job" });
  prismaMock.$queryRawUnsafe.mockResolvedValue([]);
  prismaMock.$executeRawUnsafe.mockResolvedValue(1);
  prismaMock.datasetSource.findUniqueOrThrow.mockResolvedValue({ sourceKind: "table", deltaColumn: null, lastDeltaValue: null, keyColumn: null, avgRunMs: null, lastRowCount: null, dataset: { storageServerId: null } });
  storage.tableExists.mockResolvedValue(true);
  for (const f of [storage.createSchemaIfNotExists, storage.dropTableIfExists, storage.createTable, storage.bulkInsert]) f.mockResolvedValue(undefined);
  storage.atomicSwap.mockResolvedValue({ marked: 0 });
  storage.countRows.mockResolvedValue(BigInt(prev));
  storage.query.mockImplementation(async (sql: string) => (sql.includes("GROUP BY") ? [] : sql.includes("cw_deleted_at") ? [{ n: prev }] : [{ n: 0 }]));
  storage.serverNow.mockResolvedValue(new Date());
  streams.rows.mockImplementation(() => rows());
}
const lastUpdate = () => prismaMock.datasetSource.update.mock.calls.at(-1)![0].data as Record<string, unknown>;

describe("H3: guarda de queda/vazio da fonte", () => {
  beforeEach(() => vi.clearAllMocks());

  it("tabela sem chave agendada com queda grande: barrada (protecao ligada por padrao)", async () => {
    setup(base(), () => nRows(100));
    await expect(refreshDatasetSource(ID)).rejects.toThrow(/DROP_GT_PCT/);
    expect(storage.atomicSwap).not.toHaveBeenCalled();
  });

  it("a MESMA queda em atualizacao MANUAL publica e marca SUSPECT (nao FAILED)", async () => {
    setup(base(), () => nRows(100));
    await refreshDatasetSource(ID, { manual: true });
    expect(storage.atomicSwap).toHaveBeenCalledTimes(1);
    expect(lastUpdate().lastStatus).toBe("completed");
    expect(String(lastUpdate().lastError)).toContain("INTEGRITY_SUSPECT");
  });

  it("origem vazia: manual sem confirmacao continua barrada; com acceptDrop publica", async () => {
    setup(base(), () => empty());
    await expect(refreshDatasetSource(ID, { manual: true })).rejects.toThrow(/EMPTY_REPLACE/);
    setup(base(), () => empty());
    await refreshDatasetSource(ID, { manual: true, acceptDrop: true });
    expect(storage.atomicSwap).toHaveBeenCalledTimes(1);
  });

  it("consulta com janela e sem chave: resultado vazio (virada de mes) publica com SUSPECT, nunca FAILED", async () => {
    setup(base({ sourceKind: "query", sourceSql: "SELECT 1 WHERE false" }), () => empty());
    await refreshDatasetSource(ID);
    expect(storage.atomicSwap).toHaveBeenCalledTimes(1);
    expect(lastUpdate().lastStatus).toBe("completed");
    expect(String(lastUpdate().lastError)).toContain("INTEGRITY_SUSPECT");
  });

  it("override por fonte (maxDropPct) e lido das opcoes gravadas", async () => {
    setup(base(), () => nRows(100));
    prismaMock.$queryRawUnsafe.mockImplementation(async (_q: string, key: string) => (key === `source.options.${ID}` ? [{ value: JSON.stringify({ maxDropPct: 95 }) }] : []));
    await refreshDatasetSource(ID);
    expect(storage.atomicSwap).toHaveBeenCalledTimes(1);
  });

  it("reconciliacao enfileirada por escalada carrega a queda ja medida e passa pela barra (fim do deadlock)", async () => {
    // rodada de escalada: chave + deteccao, 60% ausentes na origem => marca gravada
    async function* keys() { yield [{ Id: 1 }]; }
    setup(base({ sourceKind: "query", sourceSql: "SELECT 1", sourceSqlReconciliation: "SELECT 2", keysSql: "SELECT \"Id\" FROM keys_sql_marker", keyColumn: "id", detectDeletions: true, lastError: "KEYS_CHECK_UNSAFE[skips=2]: x", lastRowCount: 100n }), () => keys(), 100);
    storage.countMissingKeys.mockResolvedValue({ live: 100, candidates: 60 });
    streams.rows.mockImplementation((q: string) => (q.includes("keys_sql_marker") ? keys() : empty()));
    await refreshDatasetSource(ID);
    const marker = prismaMock.$executeRawUnsafe.mock.calls.find((c) => c[1] === `source.run.${ID}`);
    expect(marker).toBeTruthy();
    const m = JSON.parse(marker![2] as string);
    expect(m).toMatchObject({ reconciliation: true });
    expect(m.allowDropPct).toBeGreaterThanOrEqual(60);

    // a reconciliacao (leitura completa com 40 linhas de 100) le a marca e NAO e barrada
    vi.clearAllMocks();
    setup(base({ sourceKind: "query", sourceSql: "SELECT 1", sourceSqlReconciliation: "SELECT 2", keyColumn: "id", detectDeletions: true, lastRowCount: 100n }), () => nRows(40), 100);
    prismaMock.$queryRawUnsafe.mockImplementation(async (_q: string, key: string) => (key === `source.run.${ID}` ? [{ value: JSON.stringify(m) }] : []));
    await refreshDatasetSource(ID, { reconciliation: true });
    expect(storage.atomicSwap).toHaveBeenCalledTimes(1);
    // sem a marca a mesma leitura e barrada
    vi.clearAllMocks();
    setup(base({ sourceKind: "query", sourceSql: "SELECT 1", sourceSqlReconciliation: "SELECT 2", keyColumn: "id", detectDeletions: true, lastRowCount: 100n }), () => nRows(40), 100);
    await expect(refreshDatasetSource(ID, { reconciliation: true })).rejects.toThrow(/DROP_GT_PCT/);
  });
});

describe("M1a: falha operacional vai para o livro como ERROR, barra de integridade como FAILED", () => {
  beforeEach(() => vi.clearAllMocks());
  // valores do INSERT em ordem: kind, dataset, table, upload, source, job, tableName, mode, attempt, outcome, VEREDITO, ...
  const verdicts = () => prismaMock.$executeRaw.mock.calls.map((c) => (c as unknown[])[11] as string);
  it("erro de rede/timeout: ERROR", async () => {
    setup(base(), () => nRows(1000));
    storage.createTable.mockRejectedValue(new Error("ETIMEDOUT"));
    await expect(refreshDatasetSource(ID)).rejects.toThrow("ETIMEDOUT");
    expect(verdicts()).toContain("ERROR");
    expect(verdicts()).not.toContain("FAILED");
  });
  it("barra de integridade: FAILED", async () => {
    setup(base(), () => nRows(100));
    await expect(refreshDatasetSource(ID)).rejects.toThrow(/DROP_GT_PCT/);
    expect(verdicts()).toContain("FAILED");
  });
});

describe("effectiveIntegrity (puro)", () => {
  it("padrao: agendada, sem override", () => {
    const e = effectiveIntegrity(INTEGRITY_DEFAULTS, {}, {}, { keylessWindowedQuery: false });
    expect(e).toMatchObject({ scheduled: true, softEmpty: false });
    expect(e.settings).toEqual(INTEGRITY_DEFAULTS);
  });
  it("manual nao e agendada; janela sem chave e soft; allowEmpty por fonte", () => {
    expect(effectiveIntegrity(INTEGRITY_DEFAULTS, {}, { manual: true }, { keylessWindowedQuery: false }).scheduled).toBe(false);
    expect(effectiveIntegrity(INTEGRITY_DEFAULTS, {}, {}, { keylessWindowedQuery: true })).toMatchObject({ scheduled: false, softEmpty: true });
    expect(effectiveIntegrity(INTEGRITY_DEFAULTS, { allowEmpty: true }, {}, { keylessWindowedQuery: false }).settings.allowEmpty).toBe(true);
    expect(evaluateLoad({ kind: "source", fullState: true, parsedRows: 0, prevRows: 100, scheduled: true }, effectiveIntegrity(INTEGRITY_DEFAULTS, { allowEmpty: true }, {}, { keylessWindowedQuery: false }).settings).verdict).toBe("OK");
  });
  it("opcoes invalidas sao ignoradas", () => {
    expect(parseOptions('{"maxDropPct":500,"onInvalid":"x","allowEmpty":"sim"}')).toEqual({});
    expect(parseOptions("nao json")).toEqual({});
  });
});

describe("M3: o perdedor da trava nao apaga a staging do novo dono", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] }); });
  afterEach(() => vi.useRealTimers());

  it("trava perdida: nao chama dropTableIfExists da staging no catch e nao sobrescreve o estado da fonte", async () => {
    async function* slow() {
      yield [{ Id: 1 }];
      await vi.advanceTimersByTimeAsync(61_000); // dispara o heartbeat (que descobre que a trava foi tomada)
      yield [{ Id: 2 }];
    }
    setup(base(), () => slow());
    // 1a chamada: claim (count 1); as seguintes (heartbeat) => 0 linhas = outro dono
    prismaMock.datasetSource.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 0 });
    await expect(refreshDatasetSource(ID)).rejects.toMatchObject({ code: "SOURCE_LEASE_LOST" });
    expect(storage.dropTableIfExists).toHaveBeenCalledTimes(1); // so o da preparacao (antes de criar a staging desta rodada)
    expect(prismaMock.datasetSource.update).not.toHaveBeenCalled();
  });

  it("falhas SEGUIDAS de renovacao contam como trava perdida", async () => {
    async function* slow() {
      yield [{ Id: 1 }];
      await vi.advanceTimersByTimeAsync(60_000 * 9);
      yield [{ Id: 2 }];
    }
    setup(base(), () => slow());
    prismaMock.datasetSource.updateMany.mockResolvedValueOnce({ count: 1 }).mockRejectedValue(new Error("db fora"));
    await expect(refreshDatasetSource(ID)).rejects.toMatchObject({ code: "SOURCE_LEASE_LOST" });
    expect(storage.dropTableIfExists).toHaveBeenCalledTimes(1);
  });
});
