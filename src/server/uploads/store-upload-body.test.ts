import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { storeUploadBody } from "./store-upload-body";

const storage = vi.hoisted(() => ({
  copyFile: vi.fn(),
  writeFile: vi.fn(),
}));

const db = vi.hoisted(() => ({
  uploadUpdate: vi.fn(),
}));

vi.mock("@/server/storage", () => storage);
vi.mock("@/server/db", () => ({
  prisma: { upload: { update: db.uploadUpdate } },
}));

function md5(input: string | Buffer) {
  return createHash("md5").update(input).digest("hex");
}

function upload(overrides: Partial<Parameters<typeof storeUploadBody>[0]> = {}) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    originalFilename: "dados.csv",
    blobName: "uploads/2026-07-13/file.csv",
    sizeBytes: BigInt(Buffer.byteLength("a,b\n1,2\n")),
    fileHash: md5("a,b\n1,2\n"),
    datasetId: null,
    tableId: null,
    mode: "replace",
    keyColumn: null,
    fullSnapshot: false,
    status: "PENDING_UPLOAD",
    progress: 0,
    previewJson: null,
    mappingJson: null,
    typeOverridesJson: null,
    rowCount: null,
    insertedCount: null,
    updatedCount: null,
    deltaJson: null,
    errorMessage: null,
    createdBy: null,
    createdAt: new Date("2026-07-13T00:00:00Z"),
    updatedAt: new Date("2026-07-13T00:00:00Z"),
    ...overrides,
  };
}

function body(data: string | Buffer) {
  return new Response(typeof data === "string" ? data : new Uint8Array(data)).body!;
}

describe("storeUploadBody", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storage.copyFile.mockResolvedValue(undefined);
    storage.writeFile.mockResolvedValue(undefined);
    db.uploadUpdate.mockResolvedValue({});
  });

  it("stores bytes and returns the server-side hash", async () => {
    const result = await storeUploadBody(upload(), body("a,b\n1,2\n"), null);

    expect(result).toEqual({ stored: true, sizeBytes: 8, fileHash: md5("a,b\n1,2\n") });
    expect(storage.writeFile).toHaveBeenCalledWith("uploads/2026-07-13/file.csv", expect.any(ReadableStream));
    expect(db.uploadUpdate).not.toHaveBeenCalled();
  });

  it("accepts gzip and validates the decompressed bytes", async () => {
    const gzipped = gzipSync(Buffer.from("a,b\n1,2\n"));
    const result = await storeUploadBody(upload(), body(gzipped), "gzip");

    expect(result.fileHash).toBe(md5("a,b\n1,2\n"));
    expect(result.sizeBytes).toBe(8);
  });

  it("rejects truncated or extra bytes before writing to storage", async () => {
    await expect(storeUploadBody(upload(), body("a,b\n1\n"), null)).rejects.toMatchObject({
      code: "UPLOAD_SIZE_MISMATCH",
    });

    expect(storage.writeFile).not.toHaveBeenCalled();
    expect(storage.copyFile).not.toHaveBeenCalled();
  });

  it("rejects content whose MD5 differs from the created upload", async () => {
    await expect(storeUploadBody(upload({ sizeBytes: 8n }), body("x,y\n3,4\n"), null)).rejects.toMatchObject({
      code: "UPLOAD_HASH_MISMATCH",
    });

    expect(storage.writeFile).not.toHaveBeenCalled();
    expect(storage.copyFile).not.toHaveBeenCalled();
  });

  it("persists a server-computed hash when the client did not send one", async () => {
    await storeUploadBody(upload({ fileHash: null }), body("a,b\n1,2\n"), null);

    expect(db.uploadUpdate).toHaveBeenCalledWith({
      where: { id: "11111111-1111-1111-1111-111111111111" },
      data: { fileHash: md5("a,b\n1,2\n") },
    });
  });
});
