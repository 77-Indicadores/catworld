import { describe, expect, it } from "vitest";
import { pickInt } from "./config";

describe("pickInt (config do worker vinda do banco)", () => {
  it("aceita inteiro na faixa", () => {
    expect(pickInt("5", 2, 1, 20)).toBe(5);
    expect(pickInt("0", 200, 0, 5000)).toBe(0);
  });
  it("texto, NaN, vazio, decimal e fora da faixa caem no fallback", () => {
    for (const bad of ["abc", "NaN", "", " ", "1.5", "0", "-3", "99"]) expect(pickInt(bad, 2, 1, 20)).toBe(2);
    expect(pickInt(undefined, 2, 1, 20)).toBe(2);
  });
});

import { beforeEach, vi } from "vitest";

const db = vi.hoisted(() => ({ rows: vi.fn() }));
vi.mock("@/server/db", () => ({ prisma: { $queryRawUnsafe: db.rows } }));

import { UPLOAD_LIMIT_DEFAULTS, getUploadLimits, getWorkerConfig, invalidateWorkerConfigCache } from "./config";

describe("configuração vem só do banco (sem env)", () => {
  beforeEach(() => {
    invalidateWorkerConfigCache();
    for (const k of ["CATWORLD_MAX_HEAVY_JOBS", "CATWORLD_UPLOAD_MAX_BYTES", "CATWORLD_XLSX_MAX_BYTES", "CATWORLD_IMPORT_BATCH_DELAY_MS"]) process.env[k] = "999";
  });
  it("ignora as envs antigas: sem valor salvo vale o padrão do código", async () => {
    db.rows.mockResolvedValue([]);
    expect(await getWorkerConfig()).toEqual({ maxHeavyJobs: 2, maxSyncsPerStorage: 3, importBatchDelayMs: 200 });
    invalidateWorkerConfigCache();
    expect(await getUploadLimits()).toEqual({ maxBytes: UPLOAD_LIMIT_DEFAULTS.max_bytes, xlsxMaxBytes: UPLOAD_LIMIT_DEFAULTS.xlsx_max_bytes });
  });
  it("usa o valor salvo e rejeita o inválido", async () => {
    db.rows.mockResolvedValue([{ key: "upload.max_bytes", value: "10485760" }, { key: "upload.xlsx_max_bytes", value: "abc" }]);
    expect(await getUploadLimits()).toEqual({ maxBytes: 10485760, xlsxMaxBytes: UPLOAD_LIMIT_DEFAULTS.xlsx_max_bytes });
  });
  it("banco indisponível: padrão do código, não erro", async () => {
    db.rows.mockRejectedValue(new Error("db fora"));
    expect((await getWorkerConfig()).maxHeavyJobs).toBe(2);
  });
});
