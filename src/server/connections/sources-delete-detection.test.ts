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
  markMissingKeysDeleted: vi.fn(),
  convertLegacyDeleted: vi.fn(),
  purgeTombstones: vi.fn(),
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
  tableColumns: vi.fn(async () => [
    { originalName: "Id", sqlName: "id", sqlType: "BIGINT", nullable: false },
    { originalName: "a", sqlName: "a", sqlType: "NVARCHAR(MAX)", nullable: true },
  ]),
}));
vi.mock("./mssql", () => ({ queryColumnsMssql: vi.fn(), quotedMssqlTable: vi.fn(), streamMssqlRows: vi.fn(), tableColumnsMssql: vi.fn() }));

import { refreshDatasetSource, assertDeleteDetection, resetLegacyCleanCache } from "./sources";

const ID = "11111111-1111-1111-1111-111111111111";
const past = new Date(Date.now() - 3600_000);

function baseSource(over: Record<string, unknown> = {}) {
  return {
    id: ID, active: true, mode: "extract", sourceKind: "table",
    sourceSchema: "public", sourceTable: "t", deltaColumn: "upd", lastDeltaValue: "2026-01-01T00:00:00.000Z", keyColumn: "id",
    refreshCron: "0 * * * *", reconciliationCron: null, sourceSql: null, sourceSqlReconciliation: null,
    scopeColumns: null, keysCheckCron: null, keysSql: null, nextKeysCheckAt: null,
    dataset: { storageServerId: null, schemaName: "ds" }, connection: { provider: "postgres" },
    targetTable: { id: "tt", sqlName: "t" },
    ...over,
  };
}

/** Gerador assincrono com lotes de chaves (uma coluna). */
function keyStream(batches: unknown[][]) {
  return (async function* () { for (const b of batches) yield b.map(k => ({ Id: k })); })();
}
async function* emptyStream() { /* origem sem linhas para a carga incremental */ }

function setup(source: Record<string, unknown>, keysBatches: unknown[][] | null) {
  prismaMock.datasetSource.findUnique.mockResolvedValue(source);
  prismaMock.datasetSource.updateMany.mockResolvedValue({ count: 1 });
  storage.tableExists.mockResolvedValue(true);
  storage.dropTableIfExists.mockResolvedValue(undefined);
  storage.createSchemaIfNotExists.mockResolvedValue(undefined);
  storage.createTable.mockResolvedValue(undefined);
  storage.bulkInsert.mockResolvedValue(undefined);
  storage.atomicSwap.mockResolvedValue({ removed: 0 });
  storage.countRows.mockResolvedValue(10n);
  storage.query.mockImplementation(async (sql: string) => (sql.includes("IS NULL") ? [{ n: 0 }] : []));
  storage.serverNow.mockResolvedValue(new Date("2026-01-01T00:00:00Z"));
  storage.markMissingKeysDeleted.mockResolvedValue({ marked: 3, candidates: 3, live: 100, aborted: false });
  storage.convertLegacyDeleted.mockResolvedValue(0);
  storage.purgeTombstones.mockResolvedValue(0);
  streams.rows.mockImplementation((q: string) => (q.includes("SELECT \"Id\"") || q.startsWith("SELECT id FROM") ? keyStream(keysBatches ?? []) : emptyStream()));
}

const lastUpdate = () => prismaMock.datasetSource.update.mock.calls.at(-1)![0].data as Record<string, unknown>;

describe("refreshDatasetSource - deteccao de exclusoes", () => {
  beforeEach(() => { vi.clearAllMocks(); streams.calls.length = 0; resetLegacyCleanCache(); });

  it("campos nulos: comportamento inalterado (sem verificacao de chaves, sem escopo)", async () => {
    setup(baseSource(), null);
    await refreshDatasetSource(ID);
    expect(storage.serverNow).not.toHaveBeenCalled();
    expect(storage.markMissingKeysDeleted).not.toHaveBeenCalled();
    expect(storage.atomicSwap.mock.calls[0]![4]).not.toHaveProperty("scopeColumns");
    const d = lastUpdate();
    expect(d.lastStatus).toBe("completed");
    expect(d.lastError).toBeNull();
    expect(d).not.toHaveProperty("nextKeysCheckAt");
    expect(d.lastRemovedCount).toBe(0n);
  });

  it("scopeColumns e repassado ao atomicSwap e o removed vai para lastRemovedCount", async () => {
    setup(baseSource({ scopeColumns: JSON.stringify(["a"]) }), null);
    storage.atomicSwap.mockResolvedValue({ removed: 7 });
    await refreshDatasetSource(ID);
    expect(storage.atomicSwap.mock.calls[0]![4]).toMatchObject({ scopeColumns: ["a"] });
    expect(lastUpdate().lastRemovedCount).toBe(7n);
  });

  it("coluna de escopo inexistente na fonte: falha 400 SCOPE_COLUMN_UNKNOWN", async () => {
    setup(baseSource({ scopeColumns: JSON.stringify(["nope"]) }), null);
    await expect(refreshDatasetSource(ID)).rejects.toMatchObject({ code: "SCOPE_COLUMN_UNKNOWN" });
    expect(storage.atomicSwap).not.toHaveBeenCalled();
  });

  it("conversao legada e purga de lapides rodam no inicio (mesma trava)", async () => {
    setup(baseSource(), null);
    await refreshDatasetSource(ID);
    expect(storage.convertLegacyDeleted).toHaveBeenCalledWith("ds", "t", "id");
    expect(storage.convertLegacyDeleted.mock.invocationCallOrder[0]).toBeLessThan(storage.atomicSwap.mock.invocationCallOrder[0]!);
  });

  it("depois de limpa, a tabela nao e varrida de novo pela conversao legada (evita scan a cada rodada)", async () => {
    setup(baseSource(), null);
    await refreshDatasetSource(ID);
    setup(baseSource(), null);
    await refreshDatasetSource(ID);
    expect(storage.convertLegacyDeleted).toHaveBeenCalledTimes(1);
  });

  it("verificacao devida (tabela): le so a chave, remove e atualiza next/last; tabela auxiliar dropada", async () => {
    setup(baseSource({ keysCheckCron: "0 3 * * *", nextKeysCheckAt: past }), [[1, 2], [3]]);
    await refreshDatasetSource(ID);
    expect(streams.calls.some(q => q === 'SELECT "Id" FROM "public"."t"' || q.includes('"Id"'))).toBe(true);
    expect(storage.bulkInsert).toHaveBeenCalled();
    const [, , keyCol, keysTable, before] = storage.markMissingKeysDeleted.mock.calls[0]!;
    expect(keyCol).toBe("id");
    expect(keysTable).toMatch(/^cw_keys_/);
    expect(before).toEqual(new Date("2026-01-01T00:00:00Z")); // relogio do storage
    expect(storage.dropTableIfExists).toHaveBeenCalledWith("ds", keysTable);
    const d = lastUpdate();
    expect(d.lastKeysCheckAt).toBeInstanceOf(Date);
    expect(d.nextKeysCheckAt).toBeInstanceOf(Date);
    expect(d.lastRemovedCount).toBe(3n);
    expect(d.lastError).toBeNull();
  });

  it("verificacao nao devida (next no futuro): nao roda", async () => {
    setup(baseSource({ keysCheckCron: "0 3 * * *", nextKeysCheckAt: new Date(Date.now() + 3600_000) }), [[1]]);
    await refreshDatasetSource(ID);
    expect(storage.markMissingKeysDeleted).not.toHaveBeenCalled();
    expect(storage.serverNow).not.toHaveBeenCalled();
    expect(lastUpdate()).not.toHaveProperty("nextKeysCheckAt");
  });

  it("nao roda durante reconciliacao", async () => {
    setup(baseSource({ keysCheckCron: "0 3 * * *", nextKeysCheckAt: past, reconciliationCron: "0 2 * * 0" }), [[1]]);
    await refreshDatasetSource(ID, { reconciliation: true });
    expect(storage.markMissingKeysDeleted).not.toHaveBeenCalled();
  });

  it("lista de chaves vazia: aborta (KEYS_CHECK_UNSAFE), nada removido, merge concluido e sem falhar o job", async () => {
    setup(baseSource({ keysCheckCron: "0 3 * * *", nextKeysCheckAt: past }), []);
    await expect(refreshDatasetSource(ID)).resolves.toBeDefined();
    expect(storage.markMissingKeysDeleted).not.toHaveBeenCalled();
    const d = lastUpdate();
    expect(d.lastStatus).toBe("completed");
    expect(String(d.lastError)).toContain("KEYS_CHECK_UNSAFE");
    expect(d).not.toHaveProperty("lastKeysCheckAt");
    expect(d.nextKeysCheckAt).toBeInstanceOf(Date); // nao repete a cada rodada
    expect(storage.dropTableIfExists).toHaveBeenCalledWith("ds", expect.stringMatching(/^cw_keys_/));
  });

  it("proporcao acima do limite: KEYS_CHECK_UNSAFE registrado em lastError, sem remover", async () => {
    setup(baseSource({ keysCheckCron: "0 3 * * *", nextKeysCheckAt: past }), [[1]]);
    storage.markMissingKeysDeleted.mockResolvedValue({ marked: 0, candidates: 60, live: 100, aborted: true });
    await refreshDatasetSource(ID);
    const d = lastUpdate();
    expect(d.lastStatus).toBe("completed");
    expect(String(d.lastError)).toContain("KEYS_CHECK_UNSAFE");
    expect(d.lastRemovedCount).toBe(0n);
    expect(d).not.toHaveProperty("lastKeysCheckAt");
  });

  it("fonte por consulta sem keysSql: aviso KEYS_SQL_REQUIRED, nao le a origem", async () => {
    setup(baseSource({ sourceKind: "query", sourceSql: "SELECT 1", keysCheckCron: "0 3 * * *", nextKeysCheckAt: past, keysSql: null }), [[1]]);
    await refreshDatasetSource(ID);
    expect(storage.markMissingKeysDeleted).not.toHaveBeenCalled();
    expect(String(lastUpdate().lastError)).toContain("KEYS_SQL_REQUIRED");
  });

  it("fonte por consulta usa keysSql do usuario", async () => {
    setup(baseSource({ sourceKind: "query", sourceSql: "SELECT 1", keysCheckCron: "0 3 * * *", nextKeysCheckAt: past, keysSql: "SELECT id FROM x" }), [[1]]);
    await refreshDatasetSource(ID);
    expect(streams.calls).toContain("SELECT id FROM x");
    expect(storage.markMissingKeysDeleted).toHaveBeenCalled();
  });

  it("nao registra valores de chave nos logs", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    setup(baseSource({ keysCheckCron: "0 3 * * *", nextKeysCheckAt: past }), [[987654321]]);
    await refreshDatasetSource(ID);
    expect(JSON.stringify(info.mock.calls)).not.toContain("987654321");
    info.mockRestore();
  });
});

describe("assertDeleteDetection (validacao da API)", () => {
  const base = { mode: "extract", sourceKind: "table", keyColumn: "id" };

  it("tudo vazio passa (comportamento atual)", () => {
    expect(() => assertDeleteDetection({ ...base, keyColumn: null })).not.toThrow();
    expect(() => assertDeleteDetection({ ...base, scopeColumns: [], keysCheckCron: "", keysSql: null })).not.toThrow();
  });
  it("escopo exige chave; coluna desconhecida e 400", () => {
    expect(() => assertDeleteDetection({ ...base, keyColumn: null, scopeColumns: ["a"] })).toThrowError(expect.objectContaining({ status: 400, code: "SCOPE_REQUIRES_KEY" }));
    expect(() => assertDeleteDetection({ ...base, scopeColumns: ["zz"] }, ["id", "a"])).toThrowError(expect.objectContaining({ status: 400, code: "SCOPE_COLUMN_UNKNOWN" }));
    expect(() => assertDeleteDetection({ ...base, scopeColumns: ["a"] }, ["id", "a"])).not.toThrow();
  });
  it("cron de chaves: invalido 400 INVALID_CRON; exige chave", () => {
    expect(() => assertDeleteDetection({ ...base, keysCheckCron: "banana" })).toThrowError(expect.objectContaining({ code: "INVALID_CRON" }));
    expect(() => assertDeleteDetection({ ...base, keyColumn: null, keysCheckCron: "0 3 * * *" })).toThrowError(expect.objectContaining({ code: "KEYS_CHECK_REQUIRES_KEY" }));
  });
  it("keysSql: proibido em tabela; obrigatorio em consulta quando ha cron", () => {
    expect(() => assertDeleteDetection({ ...base, keysSql: "SELECT id FROM t" })).toThrowError(expect.objectContaining({ code: "KEYS_SQL_NOT_ALLOWED" }));
    const q = { ...base, sourceKind: "query" };
    expect(() => assertDeleteDetection({ ...q, keysCheckCron: "0 3 * * *" })).toThrowError(expect.objectContaining({ code: "KEYS_SQL_REQUIRED" }));
    expect(() => assertDeleteDetection({ ...q, keysCheckCron: "0 3 * * *", keysSql: "SELECT id FROM t" })).not.toThrow();
  });
  it("fonte live ignora os campos (sao zerados)", () => {
    expect(() => assertDeleteDetection({ mode: "live", sourceKind: "table", scopeColumns: ["a"], keysSql: "x" })).not.toThrow();
  });
});
