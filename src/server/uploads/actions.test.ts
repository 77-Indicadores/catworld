import { beforeEach, describe, expect, it, vi } from "vitest";
import { queueImportUpload, assertTableInDataset } from "./actions";

const h = vi.hoisted(() => ({
  table: vi.fn(), dataset: vi.fn(), upload: vi.fn(), updateMany: vi.fn(), jobUpdateMany: vi.fn(), jobCreate: vi.fn(), findUnique: vi.fn(),
}));
vi.mock("@/server/db", () => {
  const tx = { upload: { updateMany: h.updateMany, findUnique: h.findUnique }, job: { updateMany: h.jobUpdateMany, create: h.jobCreate } };
  return { prisma: {
    datasetTable: { findUnique: h.table },
    dataset: { findUnique: h.dataset },
    upload: { findUniqueOrThrow: h.upload },
    $transaction: async (fn: (t: unknown) => unknown) => fn(tx),
  } };
});
vi.mock("@/server/auth/permissions", () => ({ canAccess: async () => true }));
vi.mock("./access", () => ({ assertUploadWrite: async () => undefined }));

const input = { datasetId: "d1", tableId: "t1", mode: "replace" as const, mapping: [{ originalName: "a", sqlName: "a", sqlType: "INT", nullable: true }] };

describe("upload actions guards", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    h.dataset.mockResolvedValue({ id: "d1", projectId: "p" });
    h.upload.mockResolvedValue({ sizeBytes: 1n, originalFilename: "a.csv", status: "AWAITING_CONFIRMATION" });
    h.updateMany.mockResolvedValue({ count: 1 });
    h.jobCreate.mockResolvedValue({ id: "j" });
  });

  it("rejects a tableId that belongs to another dataset", async () => {
    h.table.mockResolvedValue({ datasetId: "other" });
    await expect(assertTableInDataset("t1", "d1")).rejects.toMatchObject({ status: 404, code: "TABLE_NOT_FOUND" });
    await expect(queueImportUpload({} as never, "u1", input)).rejects.toMatchObject({ code: "TABLE_NOT_FOUND" });
    expect(h.jobCreate).not.toHaveBeenCalled();
  });

  it("queues when the table belongs to the dataset", async () => {
    h.table.mockResolvedValue({ datasetId: "d1" });
    await expect(queueImportUpload({} as never, "u1", input)).resolves.toEqual({ id: "j" });
  });

  it("409 when upload is IMPORTING", async () => {
    h.table.mockResolvedValue({ datasetId: "d1" });
    h.upload.mockResolvedValue({ sizeBytes: 1n, originalFilename: "a.csv", status: "IMPORTING" });
    await expect(queueImportUpload({} as never, "u1", input)).rejects.toMatchObject({ status: 409, code: "INVALID_UPLOAD_STATE" });
  });

  it("409 when the guarded transition loses a race (count 0)", async () => {
    h.table.mockResolvedValue({ datasetId: "d1" });
    h.updateMany.mockResolvedValue({ count: 0 });
    h.findUnique.mockResolvedValue({ status: "QUEUED_IMPORT" });
    await expect(queueImportUpload({} as never, "u1", input)).rejects.toMatchObject({ status: 409 });
    expect(h.jobCreate).not.toHaveBeenCalled();
  });
});
