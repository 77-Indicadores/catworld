import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ rows: [] as { blob_name: string }[], present: new Set<string>(), deleted: [] as string[], args: [] as unknown[] }));
vi.mock("@/server/db", () => ({ prisma: { $queryRawUnsafe: vi.fn(async (_sql: string, ...a: unknown[]) => { m.args = a; return m.rows; }) } }));
vi.mock("@/server/storage", () => ({ fileExists: (b: string) => m.present.has(b), deleteFile: async (b: string) => { m.deleted.push(b); m.present.delete(b); } }));

import { pickUploadFilesDays, purgeExpiredUploadFiles } from "./file-retention";
import { safeDownloadName } from "./download-name";

beforeEach(() => { m.rows = []; m.present = new Set(); m.deleted = []; m.args = []; });

describe("pickUploadFilesDays", () => {
  it("padrão 30; aceita 0 (não guardar) e o teto de 10 anos; lixo cai no padrão", () => {
    expect(pickUploadFilesDays(undefined)).toBe(30);
    expect(pickUploadFilesDays("0")).toBe(0);
    expect(pickUploadFilesDays("7")).toBe(7);
    expect(pickUploadFilesDays("3650")).toBe(3650);
    expect(pickUploadFilesDays("abc")).toBe(30);
    expect(pickUploadFilesDays("-1")).toBe(30);
    expect(pickUploadFilesDays("99999")).toBe(30);
  });
});

describe("purgeExpiredUploadFiles", () => {
  it("apaga só os arquivos que ainda existem e conta só esses; passa os dias como parâmetro", async () => {
    m.rows = [{ blob_name: "a.csv" }, { blob_name: "gone.csv" }, { blob_name: "b.csv" }];
    m.present = new Set(["a.csv", "b.csv"]);
    expect(await purgeExpiredUploadFiles(30)).toBe(2);
    expect(m.deleted).toEqual(["a.csv", "b.csv"]);
    expect(m.args).toEqual([30]);
  });
  it("nada expirado: não apaga nada", async () => {
    expect(await purgeExpiredUploadFiles(30)).toBe(0);
    expect(m.deleted).toEqual([]);
  });
});

describe("safeDownloadName", () => {
  it("remove aspas, barras e quebras de linha (não quebra o cabeçalho)", () => {
    expect(safeDownloadName('vendas "2026".csv')).toBe("vendas _2026_.csv");
    expect(safeDownloadName("../../etc/passwd")).toBe(".._.._etc_passwd");
    expect(safeDownloadName("a\r\nSet-Cookie: x=1.csv")).toBe("a_Set-Cookie: x=1.csv");
    expect(safeDownloadName("   ")).toBe("upload");
  });
});
