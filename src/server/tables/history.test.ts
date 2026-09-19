import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db", () => ({ prisma: {} }));

import { HISTORY_LIMIT, buildTableHistory, type JobRow, type MetricRow, type UploadRow, type VersionRow } from "./history";

const at = (min: number) => new Date(Date.parse("2026-09-19T12:00:00Z") - min * 60000);
const version = (id: string, min: number, uploadId: string | null = null, rows = 100n): VersionRow => ({ id, uploadId, rowCount: rows, createdAt: at(min) });
const upload = (id: string, over: Partial<UploadRow> = {}): UploadRow => ({ id, originalFilename: `${id}.csv`, mode: "replace", createdBy: "ana@x.com", ...over });
const metric = (id: string, jobId: string, min: number, over: Partial<MetricRow> = {}): MetricRow => ({ id, jobId, jobType: "IMPORT_UPLOAD", status: "COMPLETED", durationMs: 5000, rssAfterMb: 300, errorMessage: null, createdAt: at(min), ...over });
const job = (id: string, min: number, over: Partial<JobRow> = {}): JobRow => ({ id, type: "IMPORT_UPLOAD", status: "COMPLETED", lastError: null, createdAt: at(min), ...over });

describe("buildTableHistory: versões", () => {
  it("mais recente primeiro, contagem exata em string e origem upload x sincronização", () => {
    const h = buildTableHistory({ versions: [version("v1", 60, "u1", 1487197n), version("v2", 5, null, 9007199254740993n)], uploads: [upload("u1")], metrics: [], jobs: [] });
    expect(h.versions.map((v) => v.id)).toEqual(["v2", "v1"]);
    expect(h.versions[0]).toMatchObject({ origin: "sync", upload: null, rowCount: "9007199254740993" });
    expect(h.versions[1]).toMatchObject({ origin: "upload", rowCount: "1487197", upload: { filename: "u1.csv", mode: "replace", createdBy: "ana@x.com" } });
  });
  it("upload de versão antiga sem autor mantém createdBy nulo (nada inventado)", () => {
    const h = buildTableHistory({ versions: [version("v1", 1, "u1")], uploads: [upload("u1", { createdBy: null })], metrics: [], jobs: [] });
    expect(h.versions[0]!.upload!.createdBy).toBeNull();
  });
  it("upload apagado (retenção) cai como sincronização, sem quebrar", () => {
    const h = buildTableHistory({ versions: [version("v1", 1, "sumiu")], uploads: [], metrics: [], jobs: [] });
    expect(h.versions[0]!.origin).toBe("sync");
  });
});

describe("buildTableHistory: execuções", () => {
  it("métricas trazem duração e memória; ordena da mais recente", () => {
    const h = buildTableHistory({ versions: [], uploads: [], metrics: [metric("m1", "j1", 30), metric("m2", "j2", 5, { status: "FAILED", errorMessage: "boom" })], jobs: [] });
    expect(h.runs.map((r) => r.id)).toEqual(["m2", "m1"]);
    expect(h.runs[1]).toMatchObject({ durationMs: 5000, rssMb: 300 });
    expect(h.runs[0]).toMatchObject({ status: "FAILED", error: "boom" });
    expect(h.runsNote).toBeNull();
  });
  it("job sem métrica (anterior à versão) entra sem duração e com aviso; não duplica quem já tem métrica", () => {
    const h = buildTableHistory({ versions: [], uploads: [], metrics: [metric("m1", "j1", 10)], jobs: [job("j1", 10), job("j0", 90, { status: "FAILED", lastError: "x" })] });
    expect(h.runs.map((r) => r.jobId)).toEqual(["j1", "j0"]);
    const old = h.runs.find((r) => r.jobId === "j0")!;
    expect(old).toMatchObject({ durationMs: null, rssMb: null, status: "FAILED", error: "x" });
    expect(h.runsNote).toMatch(/anteriores a esta versão/);
  });
  it("respeita o limite (padrão 20) e vazio devolve listas vazias", () => {
    const many = Array.from({ length: 30 }, (_, i) => metric(`m${i}`, `j${i}`, i));
    expect(buildTableHistory({ versions: [], uploads: [], metrics: many, jobs: [] }).runs).toHaveLength(HISTORY_LIMIT);
    expect(buildTableHistory({ versions: [], uploads: [], metrics: many, jobs: [] }, 5).runs).toHaveLength(5);
    expect(buildTableHistory({ versions: [], uploads: [], metrics: [], jobs: [] })).toEqual({ versions: [], runs: [], runsNote: null });
  });
});
