import { describe, expect, it } from "vitest";
import { KNOWN_JOB_TYPES, memoryLimitBytes, needsRestart, profileCreateSchema, profilePatchSchema, uncoveredJobTypes } from "./profiles";

describe("profileCreateSchema", () => {
  const ok = { name: "worker-uploads", jobTypes: ["PREVIEW_UPLOAD", "IMPORT_UPLOAD"] };
  it("aplica os padrões e remove tipos repetidos", () => {
    const p = profileCreateSchema.parse({ ...ok, jobTypes: ["IMPORT_UPLOAD", "IMPORT_UPLOAD"] });
    expect(p).toMatchObject({ concurrency: 1, pollMs: 2000, duckdbMemoryLimit: "1GB", enabled: true, jobTypes: ["IMPORT_UPLOAD"] });
  });
  it("nome: minúsculas, números e hífen; máx. 63", () => {
    for (const bad of ["Worker", "-a", "a b", "a_b", "", "x".repeat(64)]) expect(profileCreateSchema.safeParse({ ...ok, name: bad }).success).toBe(false);
    expect(profileCreateSchema.safeParse({ ...ok, name: "a" }).success).toBe(true);
  });
  it("tipos: pelo menos um e só os conhecidos", () => {
    expect(profileCreateSchema.safeParse({ ...ok, jobTypes: [] }).success).toBe(false);
    expect(profileCreateSchema.safeParse({ ...ok, jobTypes: ["DROP TABLE"] }).success).toBe(false);
    for (const t of KNOWN_JOB_TYPES) expect(profileCreateSchema.safeParse({ ...ok, jobTypes: [t] }).success).toBe(true);
  });
  it("faixas: concorrência 1–20, poll 250–60000, memória no formato 512MB/1.5GB", () => {
    for (const bad of [{ concurrency: 0 }, { concurrency: 21 }, { pollMs: 100 }, { pollMs: 60001 }, { duckdbMemoryLimit: "1 GB" }, { duckdbMemoryLimit: "GB" }, { duckdbMemoryLimit: "1TB" }]) {
      expect(profileCreateSchema.safeParse({ ...ok, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(profileCreateSchema.safeParse({ ...ok, concurrency: 20, pollMs: 250, duckdbMemoryLimit: "1.5GB" }).success).toBe(true);
  });
  it("patch não aceita trocar o nome", () => {
    expect(profilePatchSchema.parse({ name: "x", concurrency: 2 } as never)).toEqual({ concurrency: 2 });
  });
});

describe("regras de edição", () => {
  it("só concorrência e tipos exigem reinício", () => {
    const base = { jobTypes: ["A", "B"], concurrency: 1 };
    expect(needsRestart(base, { jobTypes: ["B", "A"], concurrency: 1 })).toBe(false);
    expect(needsRestart(base, { ...base, concurrency: 2 })).toBe(true);
    expect(needsRestart(base, { ...base, jobTypes: ["A"] })).toBe(true);
  });
  it("avisa tipos de job sem nenhum perfil habilitado", () => {
    expect(uncoveredJobTypes([{ enabled: true, jobTypes: ["PREVIEW_UPLOAD", "IMPORT_UPLOAD"] }, { enabled: false, jobTypes: ["SOURCE_REFRESH"] }]))
      .toEqual(["SOURCE_REFRESH", "DERIVED_REFRESH", "METADATA_CLEANUP"]);
    expect(uncoveredJobTypes([{ enabled: true, jobTypes: [...KNOWN_JOB_TYPES] }])).toEqual([]);
  });
  it("memoryLimitBytes", () => {
    expect(memoryLimitBytes("1GB")).toBe(1024 ** 3);
    expect(memoryLimitBytes("512MB")).toBe(512 * 1024 ** 2);
    expect(memoryLimitBytes("x")).toBeNull();
  });
});
