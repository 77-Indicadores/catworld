import { describe, expect, it } from "vitest";
import {
  JOB_WEIGHTS_BY_TYPE, KNOWN_JOB_TYPES, acceptsWeight, coverageWarnings, memoryLimitBytes, needsRestart, profileCreateSchema, profilePatchSchema,
  uncoveredJobTypes, uncoveredLanes, weightsLabel,
} from "./profiles";

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


describe("faixas (weights)", () => {
  const ok = { name: "worker-x", jobTypes: ["SOURCE_REFRESH"] };

  it("weights: padrão vazio (= todos, comportamento anterior), ordena e remove repetidos, só 0-2", () => {
    expect(profileCreateSchema.parse(ok).weights).toEqual([]);
    expect(profileCreateSchema.parse({ ...ok, weights: [2, 0, 2, 1] }).weights).toEqual([0, 1, 2]);
    for (const bad of [[3], [-1], [1.5], ["a"]]) expect(profileCreateSchema.safeParse({ ...ok, weights: bad }).success, JSON.stringify(bad)).toBe(false);
    expect(profilePatchSchema.parse({ weights: [2] }).weights).toEqual([2]);
    expect(profilePatchSchema.parse({}).weights).toBeUndefined();
  });

  it("mudar os pesos exige reiniciar o worker (ele lê o perfil no boot); ausente = vazio", () => {
    const base = { jobTypes: ["SOURCE_REFRESH"], concurrency: 1 };
    expect(needsRestart({ ...base }, { ...base, weights: [] })).toBe(false);          // legado x vazio: igual
    expect(needsRestart({ ...base, weights: [0, 1] }, { ...base, weights: [1, 0] })).toBe(false); // ordem não importa
    expect(needsRestart({ ...base, weights: [] }, { ...base, weights: [2] })).toBe(true);
  });

  it("acceptsWeight: vazio/ausente aceita tudo; senão só os listados", () => {
    expect(acceptsWeight(undefined, 2)).toBe(true);
    expect(acceptsWeight([], 0)).toBe(true);
    expect(acceptsWeight([0, 1], 1)).toBe(true);
    expect(acceptsWeight([0, 1], 2)).toBe(false);
  });

  it("os pesos possíveis de cada tipo batem com quem enfileira", () => {
    expect(JOB_WEIGHTS_BY_TYPE.SOURCE_REFRESH).toEqual([0, 2]);
    expect(JOB_WEIGHTS_BY_TYPE.DERIVED_REFRESH).toEqual([2]);
    expect(JOB_WEIGHTS_BY_TYPE.IMPORT_UPLOAD).toEqual([1, 2]);
  });

  const lane = (jobTypes: string[], weights: number[], enabled = true) => ({ enabled, jobTypes, weights });
  const FOUR = [
    lane(["SOURCE_REFRESH", "METADATA_CLEANUP"], [0, 1]),
    lane(["SOURCE_REFRESH", "DERIVED_REFRESH"], [2]),
    lane(["PREVIEW_UPLOAD", "IMPORT_UPLOAD"], [0, 1]),
    lane(["PREVIEW_UPLOAD", "IMPORT_UPLOAD"], [2]),
  ];

  it("as quatro faixas padrão cobrem todo par (tipo, peso)", () => {
    expect(uncoveredLanes(FOUR)).toEqual([]);
    expect(coverageWarnings(FOUR)).toEqual([]);
  });

  it("os perfis legados (sem filtro de peso) cobrem tudo", () => {
    const legacy = [lane(["SOURCE_REFRESH", "DERIVED_REFRESH", "METADATA_CLEANUP"], []), lane(["PREVIEW_UPLOAD", "IMPORT_UPLOAD"], [])];
    expect(uncoveredLanes(legacy)).toEqual([]);
  });

  it("faixa pesada sem worker (ex.: só o filtro leve rodando) é detectada — o job pesado ficaria na fila para sempre", () => {
    const onlyLight = [FOUR[0]!, FOUR[2]!];
    const u = uncoveredLanes(onlyLight);
    expect(u).toContainEqual({ type: "SOURCE_REFRESH", weight: 2 });
    expect(u).toContainEqual({ type: "DERIVED_REFRESH", weight: 2 });
    expect(u).toContainEqual({ type: "IMPORT_UPLOAD", weight: 2 });
    const w = coverageWarnings(onlyLight);
    expect(w.some((m) => m.includes("SOURCE_REFRESH pesados") && m.includes("peso 2"))).toBe(true);
    // DERIVED_REFRESH não tem NENHUM perfil: aparece como tipo, não duplica como faixa
    expect(w.some((m) => m.startsWith("Nenhum perfil habilitado processa: DERIVED_REFRESH"))).toBe(true);
    expect(w.some((m) => m.includes("DERIVED_REFRESH pesados"))).toBe(false);
  });

  it("perfil desabilitado não cobre", () => {
    const off = FOUR.map((p, i) => (i === 1 ? { ...p, enabled: false } : p));
    expect(uncoveredLanes(off)).toContainEqual({ type: "SOURCE_REFRESH", weight: 2 });
  });

  it("weightsLabel em português", () => {
    expect(weightsLabel([])).toBe("todas as cargas");
    expect(weightsLabel(undefined)).toBe("todas as cargas");
    expect(weightsLabel([1, 0])).toBe("só cargas leves");
    expect(weightsLabel([2])).toBe("só cargas pesadas");
    expect(weightsLabel([0, 2])).toBe("pesos 0,2");
  });
});
