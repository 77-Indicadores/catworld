import { describe, expect, it } from "vitest";
import {
  LANES, LANE_NAMES, PRESETS, PRESET_IDS, describeEffective, detectPreset, diffCapacity, getPreset, laneByName, lanesConfigured, summarize,
  validateCapacity, type Capacity,
} from "./worker-presets";

const [SYNC, SYNC_LONG, UP, UP_HEAVY] = ["worker-sync", "worker-sync-long", "worker-uploads", "worker-uploads-heavy"] as const;

/** Estado LEGADO de hoje: 2 perfis com 1 slot, sem faixas, tetos 4/4, pausa 200 ms. */
const legacy = (over: Partial<Capacity> = {}): Capacity => ({
  slots: { [SYNC]: 1, [UP]: 1 }, lanes: false, max_heavy_jobs: 4, max_syncs_per_storage: 4, import_batch_delay_ms: 200, ...over,
});
const withLanes = (s: [number, number, number, number], over: Partial<Capacity> = {}): Capacity => ({
  slots: { [SYNC]: s[0], [SYNC_LONG]: s[1], [UP]: s[2], [UP_HEAVY]: s[3] }, lanes: true, max_heavy_jobs: 4, max_syncs_per_storage: 4, import_batch_delay_ms: 200, ...over,
});

describe("LANES", () => {
  it("são quatro e cobrem todo par (tipo, peso) que existe (sem job órfão)", () => {
    expect(LANES.map((l) => l.id)).toEqual(["syncFast", "syncLong", "uploadsLight", "uploadsHeavy"]);
    const possible: Record<string, number[]> = { PREVIEW_UPLOAD: [0, 2], IMPORT_UPLOAD: [1, 2], SOURCE_REFRESH: [0, 2], DERIVED_REFRESH: [2], METADATA_CLEANUP: [0] };
    for (const [type, weights] of Object.entries(possible)) {
      for (const w of weights) {
        expect(LANES.some((l) => (l.jobTypes as readonly string[]).includes(type) && l.weights.includes(w)), `${type} peso ${w}`).toBe(true);
      }
    }
  });

  it("nomes estáveis: os dois antigos viram as faixas leves, os novos são -long e -heavy", () => {
    expect(LANE_NAMES).toEqual([SYNC, SYNC_LONG, UP, UP_HEAVY]);
    expect(laneByName(SYNC)!.weights).toEqual([0, 1]);
    expect(laneByName(UP_HEAVY)!.weights).toEqual([2]);
    expect(laneByName("worker-x")).toBeUndefined();
  });

  it("lanesConfigured exige as 4 faixas habilitadas, com tipos e pesos certos", () => {
    const ok = LANES.map((l) => ({ name: l.name, enabled: true, jobTypes: [...l.jobTypes], weights: [...l.weights] }));
    expect(lanesConfigured(ok)).toBe(true);
    expect(lanesConfigured(ok.slice(0, 3))).toBe(false);                                   // falta uma
    expect(lanesConfigured(ok.map((p, i) => (i === 1 ? { ...p, enabled: false } : p)))).toBe(false); // desabilitada
    expect(lanesConfigured(ok.map((p, i) => (i === 0 ? { ...p, weights: [] } : p)))).toBe(false);    // sem filtro de peso
    expect(lanesConfigured(ok.map((p, i) => (i === 2 ? { ...p, jobTypes: ["IMPORT_UPLOAD"] } : p)))).toBe(false); // tipos diferentes
    expect(lanesConfigured(ok.map((p, i) => (i === 0 ? { ...p, weights: [1, 0] } : p)))).toBe(true);  // ordem não importa
  });
});

describe("PRESETS", () => {
  it("são três, com ids estáveis e exatamente um recomendado", () => {
    expect(PRESET_IDS).toEqual(["economico", "equilibrado", "alto"]);
    expect(PRESETS.filter((p) => p.recommended).map((p) => p.id)).toEqual(["equilibrado"]);
  });

  it("todo preset define as QUATRO faixas e é coerente consigo mesmo (sem erro nem aviso)", () => {
    for (const p of PRESETS) {
      expect(p.capacity.lanes, p.id).toBe(true);
      for (const name of LANE_NAMES) expect(p.capacity.slots[name], `${p.id}/${name}`).toBeGreaterThanOrEqual(1);
      expect(validateCapacity(p.capacity), p.id).toEqual({ errors: [], warnings: [] });
    }
  });

  it("crescem de verdade em todas as faixas (o defeito antigo era só mexer em tetos)", () => {
    const [eco, eq, alto] = PRESETS.map((p) => p.capacity);
    for (const name of [SYNC, UP]) {
      expect(eco!.slots[name]).toBeLessThan(eq!.slots[name]!);
      expect(eq!.slots[name]).toBeLessThan(alto!.slots[name]!);
    }
    expect(eq!.slots[SYNC_LONG]).toBeLessThan(alto!.slots[SYNC_LONG]!);
    expect(eq!.slots[UP_HEAVY]).toBeLessThan(alto!.slots[UP_HEAVY]!);
    expect(eco!.import_batch_delay_ms).toBeGreaterThan(eq!.import_batch_delay_ms);
    expect(eq!.import_batch_delay_ms).toBeGreaterThan(alto!.import_batch_delay_ms);
  });

  it("o preset recomendado dá ao sync RÁPIDO mais slots que o longo (a onda das :00 não espera a ADL)", () => {
    const eq = getPreset("equilibrado")!.capacity;
    expect(eq.slots[SYNC]).toBeGreaterThan(eq.slots[SYNC_LONG]!);
  });

  it("getPreset devolve o preset ou undefined", () => {
    expect(getPreset("equilibrado")?.label).toBe("Equilibrado");
    expect(getPreset("nao-existe")).toBeUndefined();
  });
});

describe("detectPreset", () => {
  it("reconhece cada preset pelos valores", () => {
    for (const p of PRESETS) expect(detectPreset(p.capacity)).toBe(p.id);
  });

  it("qualquer número diferente vira 'custom'", () => {
    const eq = getPreset("equilibrado")!.capacity;
    expect(detectPreset({ ...eq, import_batch_delay_ms: 151 })).toBe("custom");
    expect(detectPreset({ ...eq, max_heavy_jobs: 3 })).toBe("custom");
    expect(detectPreset({ ...eq, slots: { ...eq.slots, [SYNC]: 4 } })).toBe("custom");
    expect(detectPreset({ ...eq, slots: { ...eq.slots, [UP_HEAVY]: 2 } })).toBe("custom");
  });

  it("sem as faixas configuradas NUNCA é um preset, mesmo com os números iguais (o legado de hoje é 'custom')", () => {
    const eq = getPreset("equilibrado")!.capacity;
    expect(detectPreset({ ...eq, lanes: false })).toBe("custom");
    expect(detectPreset(legacy())).toBe("custom");
    expect(describeEffective(legacy())).toBe("1 sync por vez e 1 upload por vez");
  });

  it("slots de perfis não padrão não influenciam a detecção", () => {
    const eq = getPreset("equilibrado")!.capacity;
    expect(detectPreset({ ...eq, slots: { ...eq.slots, "worker-relatorios": 9 } })).toBe("equilibrado");
  });
});

describe("diffCapacity", () => {
  it("do legado para um preset: liga as faixas (reinicia os 2 existentes), cria os 2 perfis novos e mostra os tetos", () => {
    const rows = diffCapacity(legacy(), getPreset("equilibrado")!.capacity);
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by.lanes).toMatchObject({ fromText: "desligadas", toText: "ligadas" });
    expect(by.lanes!.restart!.sort()).toEqual([SYNC, UP]);
    expect(by[`slots.${SYNC}`]).toMatchObject({ from: 1, to: 3, restart: [SYNC] });
    expect(by[`slots.${UP}`]).toMatchObject({ from: 1, to: 2, restart: [UP] });
    expect(by[`slots.${SYNC_LONG}`]).toMatchObject({ from: 0, to: 1, createsProfile: SYNC_LONG });
    expect(by[`slots.${UP_HEAVY}`]).toMatchObject({ from: 0, to: 1, createsProfile: UP_HEAVY });
    expect(by.max_heavy_jobs).toMatchObject({ from: 4, to: 2 });
    expect(by.max_heavy_jobs!.restart).toBeUndefined();
    expect(by.max_syncs_per_storage).toMatchObject({ from: 4, to: 2 });
    expect(by.import_batch_delay_ms).toMatchObject({ from: 200, to: 150 });
  });

  it("entre faixas já ligadas: só o que mudou, e só os slots pedem reinício", () => {
    const rows = diffCapacity(getPreset("economico")!.capacity, getPreset("alto")!.capacity);
    expect(rows.find((r) => r.key === "lanes")).toBeUndefined();
    expect(rows.some((r) => r.createsProfile)).toBe(false);
    expect(rows.find((r) => r.key === `slots.${SYNC}`)).toMatchObject({ from: 1, to: 5, restart: [SYNC] });
    expect(rows.find((r) => r.key === "import_batch_delay_ms")).toMatchObject({ from: 500, to: 0 });
  });

  it("iguais: nenhuma linha", () => {
    expect(diffCapacity(getPreset("alto")!.capacity, getPreset("alto")!.capacity)).toEqual([]);
  });
});

describe("summarize", () => {
  it("máximo simultâneo é a soma dos 4 slots; leituras por storage é o menor entre teto e slots de sync (rápido + longo)", () => {
    const s = summarize(getPreset("equilibrado")!.capacity);
    expect(s.maxConcurrent).toBe(7);        // 3 + 1 + 2 + 1
    expect(s.maxReadsPerStorage).toBe(2);   // teto 2, 4 slots de sync
    expect(summarize(withLanes([1, 1, 1, 1], { max_syncs_per_storage: 9 })).maxReadsPerStorage).toBe(2); // 1+1 slots
  });

  it("memória: uploads pesam mais que sync; pico >= típica; cresce do Econômico ao Alto", () => {
    const eco = summarize(getPreset("economico")!.capacity), alto = summarize(getPreset("alto")!.capacity);
    expect(eco.memoryPeakGb).toBeGreaterThanOrEqual(eco.memoryTypicalGb);
    expect(alto.memoryPeakGb).toBeGreaterThan(eco.memoryPeakGb);
    // 1 slot de upload custa mais que 1 slot de sync
    expect(summarize(withLanes([1, 1, 3, 1])).memoryPeakGb).toBeGreaterThan(summarize(withLanes([3, 1, 1, 1])).memoryPeakGb);
  });

  it("perfis extras entram na soma de slots", () => {
    expect(summarize({ ...withLanes([1, 1, 1, 1]), slots: { ...withLanes([1, 1, 1, 1]).slots, "worker-extra": 2 } }).maxConcurrent).toBe(6);
  });
});

describe("validateCapacity", () => {
  it("com faixas: teto de pesados menor que sync longo + uploads pesados avisa que as pesadas esperam umas pelas outras", () => {
    const v = validateCapacity(withLanes([3, 2, 2, 2], { max_heavy_jobs: 2, max_syncs_per_storage: 2 }));
    expect(v.errors).toEqual([]);
    expect(v.warnings.some((w) => w.includes("teto de jobs pesados") && w.includes("esperar umas pelas outras"))).toBe(true);
  });

  it("sem faixas (legado): teto menor que os slots de sync avisa que os syncs completos rodam um de cada vez", () => {
    const v = validateCapacity(legacy({ slots: { [SYNC]: 3, [UP]: 1 }, max_heavy_jobs: 1, max_syncs_per_storage: 1 }));
    expect(v.warnings.some((w) => w.includes("teto de jobs pesados") && w.includes("um de cada vez"))).toBe(true);
  });

  it("leituras por storage acima dos slots de sync avisa que o real é menor (os sliders de hoje: 4 com 1 slot)", () => {
    expect(validateCapacity(legacy()).warnings.some((w) => w.includes("o real é 1"))).toBe(true);
  });

  it("slot zero em qualquer faixa é erro", () => {
    expect(validateCapacity(withLanes([0, 1, 1, 1])).errors).toHaveLength(1);
    expect(validateCapacity(withLanes([1, 1, 1, 0])).errors[0]).toContain("Uploads pesados");
  });

  it("aviso de memória só quando o limite é informado e o pico o excede", () => {
    const alto = getPreset("alto")!.capacity;
    expect(validateCapacity(alto, 0).warnings).toEqual([]);
    expect(validateCapacity(alto, 64).warnings).toEqual([]);
    const v = validateCapacity(alto, 4);
    expect(v.errors).toEqual([]);
    expect(v.warnings.some((w) => w.includes("Memória de pico") && /\d,\d/.test(w))).toBe(true); // vírgula decimal
  });
});

describe("describeEffective", () => {
  it("com faixas descreve as quatro", () => {
    expect(describeEffective(getPreset("equilibrado")!.capacity)).toBe("3 syncs rápidos, 1 sync longo, 2 uploads leves, 1 upload pesado por vez");
  });
});
