import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  dataset: { findUnique: vi.fn() },
  connection: { findUnique: vi.fn() },
  datasetSource: { findUnique: vi.fn(), findFirst: vi.fn() },
  datasetTable: { findUnique: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
}));

vi.mock("@/server/db", () => ({ prisma: prismaMock }));
vi.mock("@/server/db/advisory-lock", () => ({ withAdvisoryLock: (_k: string, fn: () => unknown) => fn() }));
vi.mock("@/server/azure/sql", () => ({ sqlPool: vi.fn(), ensureSchema: vi.fn() }));
vi.mock("@/server/storage/connection", () => ({ getStorageConnection: vi.fn() }));
vi.mock("./mssql", () => ({ queryColumnsMssql: vi.fn(), quotedMssqlTable: vi.fn(), streamMssqlRows: vi.fn(), tableColumnsMssql: vi.fn() }));

const candidateColumns = vi.hoisted(() => ({ current: [] as { originalName: string; sqlName: string; sqlType: string; nullable: boolean }[] }));
vi.mock("./postgres", () => ({
  queryColumns: vi.fn(async () => candidateColumns.current),
  tableColumns: vi.fn(async () => candidateColumns.current),
  quotedPgTable: (s: string, t: string) => `"${s}"."${t}"`,
  streamPostgresRows: vi.fn(),
  sourceClockPg: vi.fn(async () => new Date()),
}));

import { createDatasetSource } from "./sources";

const DATASET = { id: "ds1" };
const CONNECTION = { id: "conn1", active: true, provider: "postgres" };
// Marca "chegou depois do gate": o upsert real da tabela nao e o que estamos testando aqui.
const PAST_GATE = new Error("PAST_GATE_SENTINEL");

describe("createDatasetSource: gate de compatibilidade de schema (replacesSourceId)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.dataset.findUnique.mockResolvedValue(DATASET);
    prismaMock.connection.findUnique.mockResolvedValue(CONNECTION);
    prismaMock.datasetTable.findUnique.mockResolvedValue(null); // sem tabela existente com esse nome
    prismaMock.datasetTable.upsert.mockRejectedValue(PAST_GATE);
  });

  const create = (over: Record<string, unknown> = {}) => createDatasetSource({
    datasetId: DATASET.id, connectionId: CONNECTION.id, mode: "extract", sourceKind: "table",
    sourceSchema: "public", sourceTable: "faturas", ...over,
  });

  it("sem replacesSourceId: comportamento inalterado (nao ha gate, chega ate a persistencia)", async () => {
    candidateColumns.current = [{ originalName: "valor", sqlName: "valor", sqlType: "NVARCHAR(MAX)", nullable: true }];
    await expect(create()).rejects.toBe(PAST_GATE);
    expect(prismaMock.datasetSource.findUnique).not.toHaveBeenCalled();
  });

  it("replacesSourceId inexistente: 404 REPLACES_SOURCE_NOT_FOUND, nada e escrito", async () => {
    candidateColumns.current = [{ originalName: "valor", sqlName: "valor", sqlType: "NVARCHAR(MAX)", nullable: true }];
    prismaMock.datasetSource.findUnique.mockResolvedValue(null);
    await expect(create({ replacesSourceId: "old-1" })).rejects.toMatchObject({ status: 404, code: "REPLACES_SOURCE_NOT_FOUND" });
    expect(prismaMock.datasetTable.upsert).not.toHaveBeenCalled();
  });

  it("mudanca estrutural de tipo (DECIMAL -> texto): recusa a criacao com 409 SCHEMA_INCOMPATIBLE, nada e escrito", async () => {
    candidateColumns.current = [{ originalName: "valor", sqlName: "valor", sqlType: "NVARCHAR(MAX)", nullable: true }];
    prismaMock.datasetSource.findUnique.mockResolvedValue({ targetTable: { columns: [{ sqlName: "valor", sqlType: "DECIMAL(18,4)" }] } });
    await expect(create({ replacesSourceId: "old-1" })).rejects.toMatchObject({
      status: 409,
      code: "SCHEMA_INCOMPATIBLE",
      details: { schemaCheck: { hasBreakingChange: true } },
    });
    expect(prismaMock.datasetTable.upsert).not.toHaveBeenCalled();
  });

  it("mudanca estrutural + acceptBreakingChange: passa do gate (chega na persistencia)", async () => {
    candidateColumns.current = [{ originalName: "valor", sqlName: "valor", sqlType: "NVARCHAR(MAX)", nullable: true }];
    prismaMock.datasetSource.findUnique.mockResolvedValue({ targetTable: { columns: [{ sqlName: "valor", sqlType: "DECIMAL(18,4)" }] } });
    await expect(create({ replacesSourceId: "old-1", acceptBreakingChange: true })).rejects.toBe(PAST_GATE);
  });

  it("so mudanca tolerada (sem acceptBreakingChange): passa do gate normalmente", async () => {
    candidateColumns.current = [{ originalName: "preco", sqlName: "preco", sqlType: "DECIMAL(19,4)", nullable: true }];
    prismaMock.datasetSource.findUnique.mockResolvedValue({ targetTable: { columns: [{ sqlName: "preco", sqlType: "DECIMAL(18,4)" }] } });
    await expect(create({ replacesSourceId: "old-1" })).rejects.toBe(PAST_GATE);
  });
});
