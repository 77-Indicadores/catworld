/**
 * Perfis de desempenho dos workers (Econômico / Equilibrado / Alto desempenho) e a regra que os cerca.
 *
 * Função pura, compartilhada entre a tela e a API: um preset define TUDO o que a tela mostra — os slots das QUATRO FAIXAS
 * de worker + os tetos globais + a pausa entre lotes —, então escolhê-lo tem efeito real. (Antes os presets só mexiam em
 * 3 tetos globais e, como cada worker tinha 1 slot, "Máximo" quase não mudava o paralelismo.)
 *
 * FAIXAS: um job tem um "peso" (0/1 = leve, 2 = pesado) e cada faixa é um worker que só pega certos tipos e pesos. Assim um
 * job longo (ex.: a incremental da ADL, ~5 min) não segura a fila dos curtos (~4 s) nem os previews de upload esperam um
 * import de 20 min. O peso de fontes vem do histórico de duração (sources.ts: classifySourceLane); o de uploads, do tamanho.
 *
 * Sem estado escondido: o preset é só um rótulo DETECTADO a partir dos valores (`detectPreset`). Editou qualquer número,
 * vira "personalizado". Nada aqui importa módulos de servidor (roda no navegador).
 */

import { fmtDecimal } from "@/lib/present/count";

export type JobTypeName = "PREVIEW_UPLOAD" | "IMPORT_UPLOAD" | "SOURCE_REFRESH" | "DERIVED_REFRESH" | "METADATA_CLEANUP";

export type LaneId = "syncFast" | "syncLong" | "uploadsLight" | "uploadsHeavy";

export type Lane = {
  id: LaneId;
  /** nome do perfil de worker que implementa a faixa (criado pelo preset se não existir) */
  name: string;
  label: string;
  hint: string;
  jobTypes: readonly JobTypeName[];
  /** pesos que a faixa aceita */
  weights: readonly number[];
  /** de qual perfil herdar poll/memória ao criar (o "irmão" mais antigo) */
  family: "sync" | "uploads";
};

/** As quatro faixas. `worker-sync` e `worker-uploads` já existiam (migration 202609190001) e passam a ser as faixas leves. */
export const LANES: readonly Lane[] = [
  { id: "syncFast", name: "worker-sync", label: "Sync rápido", hint: "Fontes e limpeza que levam segundos", jobTypes: ["SOURCE_REFRESH", "METADATA_CLEANUP"], weights: [0, 1], family: "sync" },
  { id: "syncLong", name: "worker-sync-long", label: "Sync longo", hint: "Fontes de vários minutos (ex.: ADL) e tabelas derivadas", jobTypes: ["SOURCE_REFRESH", "DERIVED_REFRESH"], weights: [2], family: "sync" },
  { id: "uploadsLight", name: "worker-uploads", label: "Uploads leves", hint: "Prévia e importação de arquivos pequenos", jobTypes: ["PREVIEW_UPLOAD", "IMPORT_UPLOAD"], weights: [0, 1], family: "uploads" },
  { id: "uploadsHeavy", name: "worker-uploads-heavy", label: "Uploads pesados", hint: "Importação acima de 15 MB (CSV) ou 10 MB (Excel)", jobTypes: ["PREVIEW_UPLOAD", "IMPORT_UPLOAD"], weights: [2], family: "uploads" },
] as const;

export const LANE_NAMES: readonly string[] = LANES.map((l) => l.name);
export const laneByName = (name: string): Lane | undefined => LANES.find((l) => l.name === name);

/** Nomes dos perfis padrão (compatibilidade: os dois que existiam antes das faixas). */
export const STANDARD_PROFILES = { sync: "worker-sync", uploads: "worker-uploads" } as const;

export type PresetId = "economico" | "equilibrado" | "alto";

export type Capacity = {
  /** slots (jobs em paralelo) por nome de perfil — só os perfis que existem */
  slots: Record<string, number>;
  /** true quando as quatro faixas existem, estão habilitadas e com os tipos/pesos certos */
  lanes: boolean;
  max_heavy_jobs: number;
  max_syncs_per_storage: number;
  import_batch_delay_ms: number;
};

export type Preset = {
  id: PresetId;
  label: string;
  tagline: string;
  recommended?: boolean;
  capacity: Capacity;
};

const slots = (syncFast: number, syncLong: number, uploadsLight: number, uploadsHeavy: number) => ({
  "worker-sync": syncFast, "worker-sync-long": syncLong, "worker-uploads": uploadsLight, "worker-uploads-heavy": uploadsHeavy,
});

/**
 * Números-hipótese, a validar com o limite de memória do container e a tolerância das ERPs (ver docs/worker-architecture.md).
 * Regra de ouro: `max_heavy_jobs` >= slots de sync longo + slots de uploads pesados, senão o teto faz as faixas pesadas
 * esperarem umas pelas outras (as leves nunca são afetadas: só o peso 2 é gateado).
 */
export const PRESETS: readonly Preset[] = [
  {
    id: "economico",
    label: "Econômico",
    tagline: "Poupa ERPs e banco. Tudo roda devagar, uma coisa de cada tipo por vez.",
    capacity: { slots: slots(1, 1, 1, 1), lanes: true, max_heavy_jobs: 2, max_syncs_per_storage: 1, import_batch_delay_ms: 500 },
  },
  {
    id: "equilibrado",
    label: "Equilibrado",
    tagline: "Uso geral: uma fonte longa ou um upload pesado não travam os demais.",
    recommended: true,
    capacity: { slots: slots(3, 1, 2, 1), lanes: true, max_heavy_jobs: 2, max_syncs_per_storage: 2, import_batch_delay_ms: 150 },
  },
  {
    id: "alto",
    label: "Alto desempenho",
    tagline: "Processa o mais rápido possível. Exige servidor folgado.",
    capacity: { slots: slots(5, 2, 3, 2), lanes: true, max_heavy_jobs: 4, max_syncs_per_storage: 4, import_batch_delay_ms: 0 },
  },
] as const;

export const PRESET_IDS: readonly PresetId[] = PRESETS.map((p) => p.id);

export function getPreset(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

type ProfileShape = { name: string; enabled: boolean; jobTypes: readonly string[]; weights?: readonly number[] };
const sameSet = (a: readonly (string | number)[], b: readonly (string | number)[]) => [...a].sort().join(",") === [...b].sort().join(",");

/** As quatro faixas existem, estão habilitadas e com os tipos e pesos certos? */
export function lanesConfigured(profiles: readonly ProfileShape[]): boolean {
  return LANES.every((lane) => {
    const p = profiles.find((x) => x.name === lane.name);
    return !!p && p.enabled && sameSet(p.jobTypes, lane.jobTypes) && sameSet(p.weights ?? [], lane.weights);
  });
}

function sameCapacity(a: Capacity, b: Capacity): boolean {
  return a.lanes === b.lanes
    && LANE_NAMES.every((n) => a.slots[n] === b.slots[n])
    && a.max_heavy_jobs === b.max_heavy_jobs
    && a.max_syncs_per_storage === b.max_syncs_per_storage
    && a.import_batch_delay_ms === b.import_batch_delay_ms;
}

/** O preset cujos valores batem EXATAMENTE com os atuais, ou "custom". Sem as faixas configuradas nunca bate. */
export function detectPreset(current: Capacity): PresetId | "custom" {
  return PRESETS.find((p) => sameCapacity(p.capacity, current))?.id ?? "custom";
}

export type DiffRow = {
  key: string;
  label: string;
  unit: string;
  from: number;
  to: number;
  /** texto no lugar dos números (linha de estrutura: "desligadas" -> "ligadas") */
  fromText?: string;
  toText?: string;
  /** perfis que precisam reiniciar para a linha valer (slots/faixa só valem após reiniciar) */
  restart?: string[];
  /** perfil que será criado (sobe sozinho, sem reiniciar nada) */
  createsProfile?: string;
};

/** O que muda ao passar de `current` para `target` (só as linhas que mudam). */
export function diffCapacity(current: Capacity, target: Capacity): DiffRow[] {
  const rows: DiffRow[] = [];

  if (!current.lanes && target.lanes) {
    rows.push({
      key: "lanes", label: "Faixas de worker (rápido/longo, leve/pesado)", unit: "", from: 0, to: 1, fromText: "desligadas", toText: "ligadas",
      restart: LANES.filter((l) => current.slots[l.name] !== undefined).map((l) => l.name),
    });
  }

  for (const lane of LANES) {
    const exists = current.slots[lane.name] !== undefined;
    const from = current.slots[lane.name] ?? 0, to = target.slots[lane.name] ?? from;
    if (!exists) {
      if (target.slots[lane.name] !== undefined) rows.push({ key: `slots.${lane.name}`, label: lane.label, unit: "slots", from: 0, to, createsProfile: lane.name });
      continue;
    }
    if (from !== to) rows.push({ key: `slots.${lane.name}`, label: lane.label, unit: "slots", from, to, restart: [lane.name] });
  }

  const num = (key: keyof Omit<Capacity, "slots" | "lanes">, label: string, unit: string) => {
    if (current[key] !== target[key]) rows.push({ key, label, unit, from: current[key], to: target[key] });
  };
  num("max_syncs_per_storage", "Leituras simultâneas por storage", "");
  num("max_heavy_jobs", "Teto de jobs pesados", "");
  num("import_batch_delay_ms", "Pausa entre lotes de import", "ms");
  return rows;
}

export type Summary = {
  /** máximo de jobs ao mesmo tempo (soma dos slots) */
  maxConcurrent: number;
  /** leituras simultâneas no MESMO storage: o menor entre o teto e os slots de sync (rápido + longo) */
  maxReadsPerStorage: number;
  /** estimativa de memória (GB): típico e de pico — baseada nas RSS medidas em produção (docs/worker-architecture.md) */
  memoryTypicalGb: number;
  memoryPeakGb: number;
};

const BASE_GB = 0.5;
const UPLOAD_SLOT_TYPICAL_GB = 1.5, UPLOAD_SLOT_PEAK_GB = 3.5; // RSS média ~1,2-1,5 GB, máx ~3,7 GB por processo de upload
const SYNC_SLOT_TYPICAL_GB = 0.25, SYNC_SLOT_PEAK_GB = 0.7;    // RSS média ~250 MB, máx ~677 MB

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Número em português (vírgula decimal): 4,3. */
export const fmtNum = fmtDecimal;

const n = (cap: Capacity, name: string) => cap.slots[name] ?? 0;
const syncSlots = (cap: Capacity) => n(cap, "worker-sync") + n(cap, "worker-sync-long");
const uploadSlots = (cap: Capacity) => n(cap, "worker-uploads") + n(cap, "worker-uploads-heavy");

export function summarize(cap: Capacity): Summary {
  const knownTotal = LANE_NAMES.reduce((s, name) => s + n(cap, name), 0);
  const others = Object.entries(cap.slots).filter(([name]) => !LANE_NAMES.includes(name)).reduce((s, [, v]) => s + v, 0);
  return {
    maxConcurrent: knownTotal + others,
    maxReadsPerStorage: Math.min(cap.max_syncs_per_storage, syncSlots(cap)),
    memoryTypicalGb: round1(BASE_GB + uploadSlots(cap) * UPLOAD_SLOT_TYPICAL_GB + syncSlots(cap) * SYNC_SLOT_TYPICAL_GB),
    memoryPeakGb: round1(BASE_GB + uploadSlots(cap) * UPLOAD_SLOT_PEAK_GB + syncSlots(cap) * SYNC_SLOT_PEAK_GB),
  };
}

export type Validation = { errors: string[]; warnings: string[] };

/**
 * Regras de coerência. `errors` impedem salvar; `warnings` só avisam.
 * memoryLimitGb = 0 significa "não informado" (sem aviso de memória).
 */
export function validateCapacity(cap: Capacity, memoryLimitGb = 0): Validation {
  const errors: string[] = [], warnings: string[] = [];

  for (const lane of LANES) {
    const s = cap.slots[lane.name];
    if (s !== undefined && (!Number.isInteger(s) || s < 1)) errors.push(`A faixa "${lane.label}" precisa de pelo menos 1 slot.`);
  }

  if (cap.lanes) {
    const heavyLanes = n(cap, "worker-sync-long") + n(cap, "worker-uploads-heavy");
    if (cap.max_heavy_jobs < heavyLanes) {
      warnings.push(`O teto de jobs pesados (${cap.max_heavy_jobs}) é menor que os slots das faixas pesadas (${heavyLanes}): elas vão esperar umas pelas outras.`);
    }
  } else if (cap.slots["worker-sync"] !== undefined && cap.max_heavy_jobs < cap.slots["worker-sync"]) {
    warnings.push(`O teto de jobs pesados (${cap.max_heavy_jobs}) é menor que os slots de sync (${cap.slots["worker-sync"]}): syncs completos vão rodar um de cada vez, mesmo com mais slots.`);
  }

  const sync = syncSlots(cap);
  if (sync > 0 && cap.max_syncs_per_storage > sync) {
    warnings.push(`O limite de leituras por storage (${cap.max_syncs_per_storage}) é maior que os slots de sync (${sync}): o real é ${sync}.`);
  }

  const s = summarize(cap);
  if (memoryLimitGb > 0 && s.memoryPeakGb > memoryLimitGb) {
    warnings.push(`Memória de pico estimada (~${fmtNum(s.memoryPeakGb)} GB) acima do limite informado (${fmtNum(memoryLimitGb)} GB): risco de estourar com imports pesados ao mesmo tempo.`);
  }
  return { errors, warnings };
}

/** Texto curto do que roda de fato, para o cabeçalho ("Hoje na prática"). */
export function describeEffective(cap: Capacity): string {
  const plural = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  if (cap.lanes) {
    return [
      plural(n(cap, "worker-sync"), "sync rápido", "syncs rápidos"),
      plural(n(cap, "worker-sync-long"), "sync longo", "syncs longos"),
      plural(n(cap, "worker-uploads"), "upload leve", "uploads leves"),
      plural(n(cap, "worker-uploads-heavy"), "upload pesado", "uploads pesados"),
    ].join(", ") + " por vez";
  }
  const sync = cap.slots["worker-sync"], uploads = cap.slots["worker-uploads"];
  const parts: string[] = [];
  if (sync !== undefined) parts.push(plural(sync, "sync por vez", "syncs por vez"));
  if (uploads !== undefined) parts.push(plural(uploads, "upload por vez", "uploads por vez"));
  return parts.join(" e ");
}
