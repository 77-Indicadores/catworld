import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  datasetSource: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
  datasetColumn: { deleteMany: vi.fn(), createMany: vi.fn() },
  datasetTable: { update: vi.fn() },
  datasetVersion: { create: vi.fn() },
  $transaction: vi.fn(async () => []),
}));
const storage = vi.hoisted(() => ({
  createSchemaIfNotExists: vi.fn(),
  dropTableIfExists: vi.fn(),
  createTable: vi.fn(),
  bulkInsert: vi.fn(),
  query: vi.fn(),
  q: (s: string) => `"${s}"`,
  tableExists: vi.fn(),
  atomicSwap: vi.fn(),
  countRows: vi.fn(),
  serverNow: vi.fn(),
  countMissingKeys: vi.fn(),
}));
const streams = vi.hoisted(() => ({ rows: vi.fn(), calls: [] as string[] }));

vi.mock("@/server/db", () => ({ prisma: prismaMock }));
vi.mock("@/server/db/advisory-lock", () => ({ withAdvisoryLock: (_k: string, fn: () => unknown) => fn() }));
vi.mock("@/server/azure/sql", () => ({ sqlPool: vi.fn(), ensureSchema: vi.fn() }));
vi.mock("@/server/storage/connection", () => ({ getStorageConnection: vi.fn(async () => storage) }));
vi.mock("./postgres", () => ({
  queryColumns: vi.fn(async () => [{ originalName: "Id", sqlName: "id", sqlType: "BIGINT", nullable: false }]),
  quotedPgTable: (s: string, t: string) => `"${s}"."${t}"`,
  streamPostgresRows: (_c: unknown, q: string) => { streams.calls.push(q); return streams.rows(q); },
  sourceClockPg: vi.fn(async () => new Date("2026-01-02T00:00:00Z")),
  tableColumns: vi.fn(async () => [
    { originalName: "Id", sqlName: "id", sqlType: "BIGINT", nullable: false },
    { originalName: "upd", sqlName: "upd", sqlType: "DATETIME2", nullable: true },
    { originalName: "a", sqlName: "a", sqlType: "NVARCHAR(MAX)", nullable: true },
  ]),
}));
vi.mock("./mssql", () => ({ sourceClockMssql: vi.fn(), queryColumnsMssql: vi.fn(), quotedMssqlTable: vi.fn(), streamMssqlRows: vi.fn(), tableColumnsMssql: vi.fn() }));

import { refreshDatasetSource, assertDeleteDetection } from "./sources";

const ID = "11111111-1111-1111-1111-111111111111";
const KEYS_TABLE = "cw_keys_11111111111111111111";
const NOW = new Date("2026-01-01T00:00:00Z");

function baseSource(over: Record<string, unknown> = {}) {
  return {
    id: ID, active: true, mode: "extract", sourceKind: "table",
    sourceSchema: "public", sourceTable: "t", deltaColumn: "upd", lastDeltaValue: "2026-01-01T00:00:00.000Z", keyColumn: "id",
    refreshCron: "0 * * * *", reconciliationCron: null, sourceSql: null, sourceSqlReconciliation: null,
    detectDeletions: true, keysSql: null, keysMinIntervalMinutes: null, lastKeysCheckAt: null,
    dataset: { storageServerId: null, schemaName: "ds" }, connection: { provider: "postgres" },
    targetTable: { id: "tt", sqlName: "t" },
    ...over,
  };
}

const isKeysQuery = (q: string) => q.startsWith("SELECT \"Id\" FROM") || q.startsWith("SELECT id FROM") || q.includes("keys_sql_marker");
function keyStream(batches: unknown[][]) {
  return (async function* () { for (const b of batches) yield b.map(k => ({ Id: k })); })();
}
async function* emptyStream() { /* delta sem linhas */ }

function setup(source: Record<string, unknown>, keysBatches: unknown[][] = [[1, 2, 3]]) {
  prismaMock.datasetSource.findUnique.mockResolvedValue(source);
  prismaMock.datasetSource.updateMany.mockResolvedValue({ count: 1 });
  storage.tableExists.mockResolvedValue(true);
  storage.dropTableIfExists.mockResolvedValue(undefined);
  storage.createSchemaIfNotExists.mockResolvedValue(undefined);
  storage.createTable.mockResolvedValue(undefined);
  storage.bulkInsert.mockResolvedValue(undefined);
  storage.atomicSwap.mockResolvedValue({ marked: 0 });
  storage.countRows.mockResolvedValue(10n);
  storage.query.mockImplementation(async (sql: string) => (sql.includes("IS NULL") ? [{ n: 0 }] : []));
  storage.serverNow.mockResolvedValue(NOW);
  storage.countMissingKeys.mockResolvedValue({ live: 100, candidates: 3 });
  streams.rows.mockImplementation((q: string) => (isKeysQuery(q) ? keyStream(keysBatches) : emptyStream()));
}

const lastUpdate = () => prismaMock.datasetSource.update.mock.calls.at(-1)![0].data as Record<string, unknown>;
const swapOpts = () => storage.atomicSwap.mock.calls[0]![4] as Record<string, unknown>;

describe("refreshDatasetSource - deteccao de exclusoes (soft delete)", () => {
  beforeEach(() => { vi.clearAllMocks(); streams.calls.length = 0; });

  it("grava a duração da rodada incremental (média móvel) para classificar a faixa; reconciliação NÃO entra na média", async () => {
    setup(baseSource({ detectDeletions: false }));
    await refreshDatasetSource(ID);
    const inc = lastUpdate();
    expect(typeof inc.avgRunMs).toBe("number");
    expect(inc.avgRunMs as number).toBeGreaterThanOrEqual(0);

    vi.clearAllMocks(); streams.calls.length = 0;
    setup(baseSource({ detectDeletions: false, avgRunMs: 4000 }));
    await refreshDatasetSource(ID, { reconciliation: true });
    expect(lastUpdate()).not.toHaveProperty("avgRunMs");
  });

  it("com histórico, a média é ponderada (70/30) e não é zerada por uma rodada rápida", async () => {
    setup(baseSource({ detectDeletions: false, avgRunMs: 300_000 }));
    await refreshDatasetSource(ID);
    const avg = lastUpdate().avgRunMs as number;
    expect(avg).toBeGreaterThan(200_000);   // 0,7 x 300000 = 210000 (+ ~0 da rodada instantânea do mock)
    expect(avg).toBeLessThanOrEqual(210_100);
  });

  it("padrao desligado: nenhuma leitura extra, swap sem keysTable", async () => {
    setup(baseSource({ detectDeletions: false }));
    await refreshDatasetSource(ID);
    expect(storage.serverNow).not.toHaveBeenCalled();
    expect(storage.countMissingKeys).not.toHaveBeenCalled();
    expect(streams.calls.some(isKeysQuery)).toBe(false);
    expect(swapOpts()).not.toHaveProperty("keysTable");
    const d = lastUpdate();
    expect(d.lastStatus).toBe("completed");
    expect(d.lastError).toBeNull();
    expect(d).not.toHaveProperty("lastKeysCheckAt");
    expect(d.lastRemovedCount).toBe(0n);
  });

  it("ligado (intervalo nulo): le as chaves em toda rodada e passa keysTable/keysBefore ao MESMO swap", async () => {
    setup(baseSource());
    storage.atomicSwap.mockResolvedValue({ marked: 3 });
    await refreshDatasetSource(ID);
    expect(storage.atomicSwap).toHaveBeenCalledTimes(1);
    expect(storage.serverNow.mock.invocationCallOrder[0]).toBeLessThan(storage.atomicSwap.mock.invocationCallOrder[0]!);
    expect(swapOpts()).toMatchObject({ keysTable: KEYS_TABLE, keysBefore: NOW });
    expect(storage.createTable).toHaveBeenCalledWith("ds", KEYS_TABLE, [{ name: "id", sqlType: "BIGINT", nullable: true }]);
    const d = lastUpdate();
    expect(d.lastRemovedCount).toBe(3n);
    expect(d.lastKeysCheckAt).toBeInstanceOf(Date);
    expect(d.lastError).toBeNull();
    // tabela auxiliar removida
    expect(storage.dropTableIfExists.mock.calls.filter(c => c[1] === KEYS_TABLE).length).toBeGreaterThan(0);
    expect(storage.dropTableIfExists.mock.invocationCallOrder.at(-1)!).toBeGreaterThan(storage.atomicSwap.mock.invocationCallOrder[0]!);
  });

  it("intervalo minimo ainda nao decorrido: nao le chaves (delta normal)", async () => {
    setup(baseSource({ keysMinIntervalMinutes: 60, lastKeysCheckAt: new Date(Date.now() - 10 * 60_000) }));
    await refreshDatasetSource(ID);
    expect(streams.calls.some(isKeysQuery)).toBe(false);
    expect(swapOpts()).not.toHaveProperty("keysTable");
    expect(lastUpdate()).not.toHaveProperty("lastKeysCheckAt");
  });

  it("intervalo minimo decorrido: le chaves", async () => {
    setup(baseSource({ keysMinIntervalMinutes: 60, lastKeysCheckAt: new Date(Date.now() - 90 * 60_000) }));
    await refreshDatasetSource(ID);
    expect(swapOpts()).toMatchObject({ keysTable: KEYS_TABLE });
  });

  it("lista de chaves vazia: NAO marca (sem keysTable), aplica o delta e registra aviso; status completed", async () => {
    setup(baseSource(), []);
    await refreshDatasetSource(ID);
    expect(storage.atomicSwap).toHaveBeenCalledTimes(1);
    expect(swapOpts()).not.toHaveProperty("keysTable");
    expect(storage.countMissingKeys).not.toHaveBeenCalled();
    const d = lastUpdate();
    expect(d.lastStatus).toBe("completed");
    expect(String(d.lastError)).toContain("zero chaves");
    expect(d).not.toHaveProperty("lastKeysCheckAt");
    expect(storage.dropTableIfExists.mock.calls.some(c => c[1] === KEYS_TABLE)).toBe(true);
  });

  it("guarda de proporcao (>30% com >=50 vivas): nao marca, aplica o delta, aviso KEYS_CHECK_UNSAFE", async () => {
    setup(baseSource());
    storage.countMissingKeys.mockResolvedValue({ live: 100, candidates: 60 });
    await refreshDatasetSource(ID);
    expect(swapOpts()).not.toHaveProperty("keysTable");
    const d = lastUpdate();
    expect(d.lastStatus).toBe("completed");
    expect(String(d.lastError)).toContain("KEYS_CHECK_UNSAFE");
    expect(d.lastRemovedCount).toBe(0n);
  });

  it("contagem de guarda FALHA (ex: statement timeout do storage): delta aplicado sem marcar, aviso KEYS_CHECK_FAILED, status completed", async () => {
    setup(baseSource());
    storage.countMissingKeys.mockRejectedValue(new Error("canceling statement due to statement timeout"));
    await refreshDatasetSource(ID);
    expect(storage.atomicSwap).toHaveBeenCalledTimes(1); // o delta entra mesmo assim
    expect(swapOpts()).not.toHaveProperty("keysTable"); // sem a guarda, nada e marcado
    const d = lastUpdate();
    expect(d.lastStatus).toBe("completed");
    expect(String(d.lastError)).toContain("KEYS_CHECK_FAILED");
    expect(String(d.lastError)).toContain("statement timeout");
    expect(d.lastRemovedCount).toBe(0n);
    expect(d).not.toHaveProperty("lastKeysCheckAt");
    expect(storage.dropTableIfExists.mock.calls.some(c => c[1] === KEYS_TABLE)).toBe(true); // tabela de chaves removida
  });

  it("atualiza as estatisticas da tabela de chaves antes da contagem; falha no ANALYZE nao derruba o refresh", async () => {
    setup(baseSource());
    const analyze = vi.fn().mockResolvedValue(undefined);
    (storage as Record<string, unknown>).analyzeTable = analyze;
    try {
      await refreshDatasetSource(ID);
      expect(analyze).toHaveBeenCalledWith("ds", KEYS_TABLE);
      expect(analyze.mock.invocationCallOrder[0]).toBeLessThan(storage.countMissingKeys.mock.invocationCallOrder[0]!);
      expect(swapOpts()).toMatchObject({ keysTable: KEYS_TABLE });

      vi.clearAllMocks(); streams.calls.length = 0;
      setup(baseSource());
      analyze.mockRejectedValue(new Error("boom"));
      await refreshDatasetSource(ID);
      expect(lastUpdate().lastStatus).toBe("completed");
      expect(swapOpts()).toMatchObject({ keysTable: KEYS_TABLE });
    } finally {
      delete (storage as Record<string, unknown>).analyzeTable;
    }
  });

  it("tabela pequena (<50 vivas): proporcao nao e avaliada, marca normalmente", async () => {
    setup(baseSource());
    storage.countMissingKeys.mockResolvedValue({ live: 10, candidates: 9 });
    await refreshDatasetSource(ID);
    expect(swapOpts()).toMatchObject({ keysTable: KEYS_TABLE });
  });

  it("fonte por consulta usa keysSql; sem keysSql a marcacao e ignorada com aviso e o delta e aplicado", async () => {
    setup(baseSource({ sourceKind: "query", sourceSql: "SELECT 1", deltaColumn: null, lastDeltaValue: null, keysSql: "SELECT id FROM keys_sql_marker" }));
    await refreshDatasetSource(ID);
    expect(streams.calls).toContain("SELECT id FROM keys_sql_marker");
    expect(swapOpts()).toMatchObject({ keysTable: KEYS_TABLE });

    vi.clearAllMocks(); streams.calls.length = 0;
    setup(baseSource({ sourceKind: "query", sourceSql: "SELECT 1", deltaColumn: null, lastDeltaValue: null, keysSql: null }));
    await refreshDatasetSource(ID);
    expect(storage.atomicSwap).toHaveBeenCalledTimes(1);
    expect(swapOpts()).not.toHaveProperty("keysTable");
    expect(lastUpdate().lastStatus).toBe("completed");
    expect(String(lastUpdate().lastError)).toContain("KEYS_READ_FAILED");
    expect(String(lastUpdate().lastError)).toContain("KEYS_SQL_REQUIRED");
  });

  it("keysSql com mais de uma coluna: aviso KEYS_SQL_INVALID, delta aplicado sem marcar e tabela de chaves removida", async () => {
    setup(baseSource({ sourceKind: "query", sourceSql: "SELECT 1", deltaColumn: null, lastDeltaValue: null, keysSql: "SELECT id FROM keys_sql_marker" }));
    streams.rows.mockImplementation((q: string) => (isKeysQuery(q)
      ? (async function* () { yield [{ a: 1, b: 2 }]; })()
      : emptyStream()));
    await refreshDatasetSource(ID);
    expect(storage.dropTableIfExists.mock.calls.some(c => c[1] === KEYS_TABLE)).toBe(true);
    expect(storage.atomicSwap).toHaveBeenCalledTimes(1);
    expect(swapOpts()).not.toHaveProperty("keysTable");
    expect(String(lastUpdate().lastError)).toContain("KEYS_SQL_INVALID");
  });

  it("swap que falha: tabela de chaves ainda e removida (finally)", async () => {
    setup(baseSource());
    storage.atomicSwap.mockRejectedValue(new Error("boom"));
    await expect(refreshDatasetSource(ID)).rejects.toThrow("boom");
    expect(storage.dropTableIfExists.mock.calls.filter(c => c[1] === KEYS_TABLE).length).toBeGreaterThanOrEqual(2);
    expect(lastUpdate().lastStatus).toBe("failed");
  });

  it("reconciliacao (fullSnapshot): nao le chaves; ramo original", async () => {
    setup(baseSource());
    await refreshDatasetSource(ID, { reconciliation: true });
    expect(streams.calls.some(isKeysQuery)).toBe(false);
    expect(swapOpts()).toMatchObject({ fullSnapshot: true });
    expect(swapOpts()).not.toHaveProperty("keysTable");
  });
});

describe("assertDeleteDetection", () => {
  const ok = { mode: "extract", sourceKind: "table", keyColumn: "id" };
  it("desligado: aceita", () => expect(() => assertDeleteDetection({ ...ok, keyColumn: null })).not.toThrow());
  it("live ignora tudo", () => expect(() => assertDeleteDetection({ mode: "live", sourceKind: "query", detectDeletions: true })).not.toThrow());
  it("exige chave", () => expect(() => assertDeleteDetection({ ...ok, keyColumn: null, detectDeletions: true })).toThrowError(expect.objectContaining({ status: 400, code: "DELETE_DETECTION_REQUIRES_KEY" })));
  it("consulta exige keysSql", () => expect(() => assertDeleteDetection({ ...ok, sourceKind: "query", detectDeletions: true })).toThrowError(expect.objectContaining({ code: "KEYS_SQL_REQUIRED" })));
  it("tabela nao aceita keysSql", () => expect(() => assertDeleteDetection({ ...ok, detectDeletions: true, keysSql: "SELECT 1" })).toThrowError(expect.objectContaining({ code: "KEYS_SQL_NOT_ALLOWED" })));
  it("intervalo invalido", () => {
    for (const v of [0, -5, 1.5]) expect(() => assertDeleteDetection({ ...ok, detectDeletions: true, keysMinIntervalMinutes: v })).toThrowError(expect.objectContaining({ code: "INVALID_KEYS_INTERVAL" }));
    expect(() => assertDeleteDetection({ ...ok, detectDeletions: true, keysMinIntervalMinutes: 30 })).not.toThrow();
  });
  it("consulta valida", () => expect(() => assertDeleteDetection({ ...ok, sourceKind: "query", detectDeletions: true, keysSql: "SELECT id FROM t" })).not.toThrow());
});
