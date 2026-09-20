import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  datasetSource: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
}));
const storage = vi.hoisted(() => ({
  createSchemaIfNotExists: vi.fn(),
  dropTableIfExists: vi.fn(),
  createTable: vi.fn(),
}));

vi.mock("@/server/db", () => ({ prisma: prismaMock }));
vi.mock("@/server/db/advisory-lock", () => ({ withAdvisoryLock: (_k: string, fn: () => unknown) => fn() }));
vi.mock("@/server/azure/sql", () => ({ sqlPool: vi.fn(), ensureSchema: vi.fn() }));
vi.mock("@/server/storage/connection", () => ({ getStorageConnection: vi.fn(async () => storage) }));
vi.mock("./postgres", () => ({
  queryColumns: vi.fn(), quotedPgTable: vi.fn(), streamPostgresRows: vi.fn(),
  tableColumns: vi.fn(async () => [{ originalName: "id", sqlName: "id", sqlType: "BIGINT", nullable: false }]),
}));
vi.mock("./mssql", () => ({ queryColumnsMssql: vi.fn(), quotedMssqlTable: vi.fn(), streamMssqlRows: vi.fn(), tableColumnsMssql: vi.fn() }));

import { refreshDatasetSource } from "./sources";

describe("refreshDatasetSource", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marca a fonte como failed quando a criacao da staging falha (nao fica running)", async () => {
    prismaMock.datasetSource.findUnique.mockResolvedValue({
      id: "11111111-1111-1111-1111-111111111111", active: true, mode: "extract", sourceKind: "table",
      sourceSchema: "public", sourceTable: "t", deltaColumn: null, lastDeltaValue: null, keyColumn: null,
      refreshCron: null, reconciliationCron: null, sourceSql: null, sourceSqlReconciliation: null,
      dataset: { storageServerId: null, schemaName: "ds" }, connection: { provider: "postgres" },
      targetTable: { id: "tt", sqlName: "t" },
    });
    prismaMock.datasetSource.updateMany.mockResolvedValue({ count: 1 });
    storage.createSchemaIfNotExists.mockRejectedValue(new Error("boom"));
    storage.dropTableIfExists.mockResolvedValue(undefined);

    await expect(refreshDatasetSource("11111111-1111-1111-1111-111111111111")).rejects.toThrow("boom");
    expect(prismaMock.datasetSource.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastStatus: "failed", lastError: "boom" }) }),
    );
  });
});
