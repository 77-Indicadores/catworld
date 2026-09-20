import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { storeUploadBody } from "./store-upload-body";

const h = vi.hoisted(() => ({ writeFile: vi.fn(), limits: { maxBytes: 100, xlsxMaxBytes: 50 } }));

vi.mock("@/server/storage", () => ({ writeFile: h.writeFile }));
vi.mock("@/server/db", () => ({ prisma: { upload: { update: vi.fn() } } }));
vi.mock("@/server/worker/config", () => ({ getUploadLimits: async () => h.limits }));

const up = (name: string) => ({ id: "22222222-2222-2222-2222-222222222222", originalFilename: name, blobName: "x", sizeBytes: 10n, fileHash: null }) as never;
const body = (b: Buffer) => new Response(new Uint8Array(b)).body!;

describe("storeUploadBody limits (streaming)", () => {
  beforeEach(() => h.writeFile.mockReset());

  it("aborts with FILE_TOO_LARGE when the stream exceeds the limit regardless of declared size", async () => {
    await expect(storeUploadBody(up("a.csv"), body(Buffer.alloc(200, "a")), null)).rejects.toMatchObject({ status: 413, code: "FILE_TOO_LARGE" });
    expect(h.writeFile).not.toHaveBeenCalled();
  });

  it("aborts with XLSX_TOO_LARGE for .xlsx and .xls", async () => {
    for (const n of ["a.xlsx", "b.XLS"]) {
      await expect(storeUploadBody(up(n), body(Buffer.alloc(60, "a")), null)).rejects.toMatchObject({ status: 413, code: "XLSX_TOO_LARGE" });
    }
  });

  it("enforces the limit on gunzip output (zip bomb)", async () => {
    await expect(storeUploadBody(up("a.csv"), body(gzipSync(Buffer.alloc(5000, "a"))), "gzip")).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });
});
