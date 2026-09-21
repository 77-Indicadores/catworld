import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  datasetSource: { findUnique: vi.fn(), findMany: vi.fn(), findUniqueOrThrow: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
  datasetColumn: { deleteMany: vi.fn(), createMany: vi.fn() },
  datasetTable: { update: vi.fn() },
  datasetVersion: { create: vi.fn() },
  job: { findMany: vi.fn(), create: vi.fn() },
  $transaction: vi.fn(async (ops: unknown[]) => ops),
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
  tableColumns: vi.fn(async () => [
    { originalName: "Id", sqlName: "id", sqlType: "BIGINT", nullable: false },
    { originalName: "upd", sqlName: "upd", sqlType: "DATETIME2", nullable: true },
  ]),
}));
vi.mock("./mssql", () => ({ sourceClockMssql: vi.fn(), queryColumnsMssql: vi.fn(), quotedMssqlTable: vi.fn(), streamMssqlRows: vi.fn(), tableColumnsMssql: vi.fn() }));

import { enqueueDueSourceRefreshes, exposeSource, refreshDatasetSource } from "./sources";
import { defaultReconciliationCron, deletionCoverageWarning, extractKeysWarning, previousKeysSkips, resolveColumn, shouldResetDelta, withSkipCount } from "./source-guards";

const ID = "11111111-1111-1111-1111-111111111111";
const base = (over: Record<string, unknown> = {}) => ({
  id: ID, active: true, mode: "extract", sourceKind: "table", sourceSchema: "public", sourceTable: "t", deltaColumn: "upd",
  lastDeltaValue: "2026-01-01T00:00:00.000Z", keyColumn: "id", refreshCron: "0 * * * *", reconciliationCron: null, sourceSql: null,
  sourceSqlReconciliation: null, detectDeletions: true, keysSql: null, keysMinIntervalMinutes: null, lastKeysCheckAt: null, lastError: null,
  dataset: { storageServerId: null, schemaName: "ds" }, connection: { provider: "postgres" }, targetTable: { id: "tt", sqlName: "t" }, ...over,
});
async function* keys() { yield [{ Id: 1 }]; }
async function* none() { /* delta vazio */ }
function setup(source: Record<string, unknown>) {
  prismaMock.datasetSource.findUnique.mockResolvedValue(source);
  prismaMock.datasetSource.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.job.findMany.mockResolvedValue([]);
  prismaMock.job.create.mockResolvedValue({ id: "job" });
  prismaMock.datasetSource.findUniqueOrThrow.mockResolvedValue({ sourceKind: "table", deltaColumn: "upd", lastDeltaValue: "x", keyColumn: "id", avgRunMs: null, lastRowCount: null, dataset: { storageServerId: null } });
  storage.tableExists.mockResolvedValue(true);
  for (const f of [storage.createSchemaIfNotExists, storage.dropTableIfExists, storage.createTable, storage.bulkInsert]) f.mockResolvedValue(undefined);
  storage.atomicSwap.mockResolvedValue({ marked: 0 });
  storage.countRows.mockResolvedValue(10n);
  storage.query.mockImplementation(async (sql: string) => (sql.includes("IS NULL") ? [{ n: 0 }] : []));
  storage.serverNow.mockResolvedValue(new Date());
  storage.countMissingKeys.mockResolvedValue({ live: 100, candidates: 60 }); // sempre UNSAFE
  streams.rows.mockImplementation((q: string) => (q.startsWith("SELECT \"Id\" FROM") ? keys() : none()));
}
const lastUpdate = () => prismaMock.datasetSource.update.mock.calls.at(-1)![0].data as Record<string, unknown>;
const reconJobs = () => prismaMock.job.create.mock.calls.filter(c => JSON.parse(c[0].data.payloadJson).reconciliation === true);

describe("FON-12: verificacao de exclusoes ignorada varias vezes escala", () => {
  beforeEach(() => vi.clearAllMocks());

  it("1a e 2a rodada ignoradas: completed com aviso e contador; sem reconciliacao automatica", async () => {
    setup(base());
    await refreshDatasetSource(ID);
    expect(lastUpdate().lastStatus).toBe("completed");
    expect(String(lastUpdate().lastError)).toContain("KEYS_CHECK_UNSAFE[skips=1]:");
    setup(base({ lastError: String(lastUpdate().lastError) }));
    await refreshDatasetSource(ID);
    expect(lastUpdate().lastStatus).toBe("completed");
    expect(String(lastUpdate().lastError)).toContain("[skips=2]");
    expect(reconJobs()).toHaveLength(0);
  });

  it("3a rodada seguida: status FAILED (nao completed), mensagem KEYS_CHECK_ESCALATED e reconciliacao enfileirada", async () => {
    setup(base({ lastError: "KEYS_CHECK_UNSAFE[skips=2]: deteccao de exclusoes ignorada: x" }));
    await refreshDatasetSource(ID);
    const d = lastUpdate();
    expect(d.lastStatus).toBe("failed");
    expect(String(d.lastError)).toMatch(/KEYS_CHECK_ESCALATED.*3 rodadas seguidas/);
    expect(String(d.lastError)).toContain("KEYS_CHECK_UNSAFE[skips=3]");
    expect(reconJobs()).toHaveLength(1);
  });

  it("intervalo minimo ainda nao vencido: o aviso (e o contador) e carregado, nao zerado", async () => {
    setup(base({ keysMinIntervalMinutes: 60, lastKeysCheckAt: new Date(), lastError: "KEYS_CHECK_FAILED[skips=2]: deteccao de exclusoes ignorada: y" }));
    await refreshDatasetSource(ID);
    expect(String(lastUpdate().lastError)).toContain("KEYS_CHECK_FAILED[skips=2]");
    expect(lastUpdate().lastStatus).toBe("completed");
  });

  it("verificacao aplicada com sucesso zera o contador", async () => {
    setup(base({ lastError: "KEYS_CHECK_UNSAFE[skips=2]: z" }));
    storage.countMissingKeys.mockResolvedValue({ live: 100, candidates: 2 });
    await refreshDatasetSource(ID);
    expect(lastUpdate().lastError).toBeNull();
    expect(lastUpdate().lastStatus).toBe("completed");
  });

  it("fonte por consulta sem consulta de reconciliacao: escala o status mas nao enfileira reconciliacao impossivel", async () => {
    setup(base({ sourceKind: "query", sourceSql: "SELECT 1", keysSql: "SELECT \"Id\" FROM keys_sql_marker", deltaColumn: null, lastError: "KEYS_CHECK_UNSAFE[skips=2]: z" }));
    streams.rows.mockImplementation((q: string) => (q.includes("keys_sql_marker") ? keys() : none()));
    await refreshDatasetSource(ID);
    expect(lastUpdate().lastStatus).toBe("failed");
    expect(reconJobs()).toHaveLength(0);
  });
});

describe("FON-16: fila de fontes vencidas nao passa fome", () => {
  beforeEach(() => vi.clearAllMocks());
  it("pula as que ja tem job ativo e enfileira as seguintes (antes ficava presa nas 50 mais antigas)", async () => {
    const due = Array.from({ length: 120 }, (_, i) => ({ id: `s${i}` }));
    prismaMock.datasetSource.findMany.mockResolvedValue(due);
    prismaMock.job.findMany.mockImplementation(async (a: { where?: { type?: string } }) =>
      a?.where?.type === "SOURCE_REFRESH" ? due.slice(0, 50).map(s => ({ payloadJson: JSON.stringify({ datasetSourceId: s.id, reconciliation: false }) })) : []);
    prismaMock.datasetSource.findUniqueOrThrow.mockResolvedValue({ sourceKind: "table", deltaColumn: null, lastDeltaValue: null, keyColumn: null, avgRunMs: null, lastRowCount: null, dataset: { storageServerId: null } });
    prismaMock.datasetSource.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.job.create.mockResolvedValue({ id: "j" });
    await enqueueDueSourceRefreshes();
    const queued = prismaMock.job.create.mock.calls.map(c => JSON.parse(c[0].data.payloadJson).datasetSourceId as string);
    expect(queued).toHaveLength(50);
    expect(queued[0]).toBe("s50"); // as 50 mais antigas ja estavam na fila
    expect(queued.at(-1)).toBe("s99");
  });
});

describe("funcoes puras das guardas", () => {
  it("resolveColumn: original, saneado e sem caixa (FON-14)", () => {
    const cols = [{ originalName: "Data Emissao", sqlName: "data_emissao" }, { originalName: "Id", sqlName: "id" }];
    expect(resolveColumn(cols, "Data Emissao")?.sqlName).toBe("data_emissao");
    expect(resolveColumn(cols, "data_emissao")?.originalName).toBe("Data Emissao");
    expect(resolveColumn(cols, "ID")?.sqlName).toBe("id");
    expect(resolveColumn(cols, "data emissao")?.sqlName).toBe("data_emissao");
    expect(resolveColumn(cols, "nada")).toBeNull();
  });
  it("contador de verificacoes ignoradas vive no aviso", () => {
    expect(previousKeysSkips("KEYS_CHECK_UNSAFE[skips=2]: x")).toBe(2);
    expect(previousKeysSkips("DELTA_FUTURE_VALUES: a | KEYS_READ_FAILED[skips=5]: b")).toBe(5);
    expect(previousKeysSkips("outro erro")).toBe(0);
    expect(withSkipCount("KEYS_CHECK_FAILED: y", 3)).toBe("KEYS_CHECK_FAILED[skips=3]: y");
    expect(extractKeysWarning("DELTA_RESET: a | KEYS_CHECK_UNSAFE[skips=1]: b")).toBe("KEYS_CHECK_UNSAFE[skips=1]: b");
  });
  it("FON-08: o que redefine a leitura zera a marca; o resto nao", () => {
    const cur = { deltaColumn: "a", keyColumn: "id", sourceSql: null, mode: "extract" };
    expect(shouldResetDelta({ deltaColumn: "b" }, cur)).toBe(true);
    expect(shouldResetDelta({ keyColumn: "outro" }, cur)).toBe(true);
    expect(shouldResetDelta({ sourceSql: "SELECT 2" }, cur)).toBe(true);
    expect(shouldResetDelta({ mode: "live" }, cur)).toBe(true);
    expect(shouldResetDelta({ deltaColumn: "a", keyColumn: "id", mode: "extract" }, cur)).toBe(false);
    expect(shouldResetDelta({}, cur)).toBe(false);
  });
  it("FON-06: fonte NOVA com chave ganha reconciliacao diaria; existente so e sinalizada; escolha explicita e respeitada", () => {
    expect(defaultReconciliationCron({ mode: "extract", keyColumn: "id", sourceKind: "table" })).toBe("15 3 * * *");
    expect(defaultReconciliationCron({ mode: "extract", keyColumn: "id", sourceKind: "table", reconciliationCron: null })).toBeNull();
    expect(defaultReconciliationCron({ mode: "extract", keyColumn: null, sourceKind: "table" })).toBeNull();
    expect(defaultReconciliationCron({ mode: "extract", keyColumn: "id", sourceKind: "query" })).toBeNull(); // sem consulta de reconciliacao
    expect(defaultReconciliationCron({ mode: "extract", keyColumn: "id", detectDeletions: true, sourceKind: "table" })).toBeNull();
    const legado = { mode: "extract", keyColumn: "id", detectDeletions: false, reconciliationCron: null, sourceKind: "table" };
    expect(deletionCoverageWarning(legado)).toMatch(/NO_DELETION_DETECTION/);
    expect(exposeSource(legado).integrityWarnings).toHaveLength(1);
    expect(exposeSource({ ...legado, reconciliationCron: "0 3 * * *" }).integrityWarnings).toEqual([]);
    expect(exposeSource({ ...legado, keyColumn: null }).integrityWarnings).toEqual([]);
  });
});
