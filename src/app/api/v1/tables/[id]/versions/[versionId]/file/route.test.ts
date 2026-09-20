import { beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";

const m = vi.hoisted(() => ({
  table: { id: "", dataset: { id: "d1", projectId: "p1" } } as unknown,
  version: null as unknown, upload: null as unknown, exists: true, allowed: true, audited: [] as unknown[],
}));
vi.mock("@/server/db", () => ({ prisma: {
  datasetTable: { findUnique: vi.fn(async (a: { where: { id: string } }) => ({ ...(m.table as object), id: a.where.id })) },
  datasetVersion: { findFirst: vi.fn(async (a: { where: { tableId: string } }) => (m.version && a.where.tableId === T ? m.version : null)) },
  upload: { findUnique: vi.fn(async () => m.upload) },
} }));
vi.mock("@/server/auth/actor", () => ({ resolveActor: vi.fn(async () => ({ id: "u" })) }));
vi.mock("@/server/auth/permissions", () => ({ assertDatasetAccess: vi.fn(async () => { if (!m.allowed) { const { ApiError } = await import("@/server/http"); throw new ApiError(403, "FORBIDDEN", "Sem permissão no dataset"); } }) }));
vi.mock("@/server/audit", () => ({ audit: vi.fn(async (...a: unknown[]) => { m.audited.push(a); }) }));
vi.mock("@/server/storage", () => ({ fileExists: () => m.exists, downloadFile: async () => Readable.from([Buffer.from("a,b\n1,2\n")]) }));

import { GET } from "./route";

const T = "11111111-1111-4111-8111-111111111111", V = "22222222-2222-4222-8222-222222222222";
const call = (id = T, versionId = V) => GET(new Request("http://x") as never, { params: Promise.resolve({ id, versionId }) });

beforeEach(() => {
  m.table = { id: T, dataset: { id: "d1", projectId: "p1" } };
  m.version = { uploadId: "u1" }; m.upload = { id: "u1", blobName: "uploads/x.csv", originalFilename: 'vendas "1".csv' };
  m.exists = true; m.allowed = true; m.audited = [];
});

describe("GET /tables/:id/versions/:versionId/file", () => {
  it("devolve o arquivo como anexo, com nome seguro, e audita", async () => {
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toBe('attachment; filename="vendas _1_.csv"');
    expect(await r.text()).toBe("a,b\n1,2\n");
    expect(m.audited).toHaveLength(1);
  });
  it("sem WRITE no dataset: 403 e nada é auditado", async () => {
    m.allowed = false;
    expect((await call()).status).toBe(403);
    expect(m.audited).toHaveLength(0);
  });
  it("versão de OUTRA tabela: 404 (não dá para trocar o id e baixar arquivo alheio)", async () => {
    expect((await call("33333333-3333-4333-8333-333333333333")).status).toBe(404);
  });
  it("ids que não são uuid: 404", async () => {
    expect((await call("../x", V)).status).toBe(404);
  });
  it("versão de sincronização (sem upload): 404 NO_FILE", async () => {
    m.version = { uploadId: null };
    const r = await call();
    expect(r.status).toBe(404);
    expect((await r.json()).error.code).toBe("NO_FILE");
  });
  it("arquivo removido pela retenção: 410", async () => {
    m.exists = false;
    const r = await call();
    expect(r.status).toBe(410);
    expect((await r.json()).error.code).toBe("FILE_GONE");
  });
  it("registro do upload já removido: 410", async () => {
    m.upload = null;
    expect((await call()).status).toBe(410);
  });
});
