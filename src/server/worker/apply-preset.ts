/**
 * Lê a capacidade atual dos workers e aplica um preset (ver src/lib/worker-presets.ts) numa ÚNICA transação:
 * os quatro perfis de faixa (cria os que faltam, ajusta tipos/pesos/slots dos existentes) + os três tetos globais.
 * Não reinicia nada — devolve quais perfis precisam reiniciar (tipos, pesos e slots só valem depois de reiniciar o worker;
 * os tetos valem em até 10 s) e quais foram criados (o supervisor sobe um perfil novo sozinho, sem reiniciar nada).
 */
import { prisma } from "@/server/db";
import { WORKER_CONFIG_DEFAULTS, invalidateWorkerConfigCache, pickInt } from "@/server/worker/config";
import { PROFILE_DEFAULTS, coverageWarnings, needsRestart } from "@/server/worker/profiles";
import {
  LANES, LANE_NAMES, diffCapacity, getPreset, lanesConfigured, validateCapacity,
  type Capacity, type DiffRow, type PresetId,
} from "@/lib/worker-presets";

export const PRESET_SETTING_KEYS = {
  max_heavy_jobs: "worker.max_heavy_jobs",
  max_syncs_per_storage: "worker.max_syncs_per_storage",
  import_batch_delay_ms: "worker.import_batch_delay_ms",
} as const;

type Row = { id: string; name: string; jobTypes: string[]; weights: number[]; concurrency: number; enabled: boolean; pollMs: number; duckdbMemoryLimit: string };

async function readProfiles(): Promise<Row[]> {
  return prisma.workerProfile.findMany({
    select: { id: true, name: true, jobTypes: true, weights: true, concurrency: true, enabled: true, pollMs: true, duckdbMemoryLimit: true },
  }) as Promise<Row[]>;
}

/** Capacidade atual: slots das faixas que existem + se as 4 faixas estão configuradas + tetos globais (padrão do código quando não salvos). */
export async function readCurrentCapacity(): Promise<{ capacity: Capacity; profiles: Row[] }> {
  const [profiles, rows] = await Promise.all([
    readProfiles(),
    prisma.$queryRawUnsafe<{ key: string; value: string }[]>(
      `SELECT key, value FROM cw_system_settings WHERE key = ANY($1::text[])`,
      Object.values(PRESET_SETTING_KEYS),
    ),
  ]);
  const by = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const inScope = profiles.filter((p) => LANE_NAMES.includes(p.name));
  return {
    profiles,
    capacity: {
      slots: Object.fromEntries(inScope.map((p) => [p.name, p.concurrency])),
      lanes: lanesConfigured(profiles),
      max_heavy_jobs: pickInt(by[PRESET_SETTING_KEYS.max_heavy_jobs], WORKER_CONFIG_DEFAULTS.max_heavy_jobs, 1, 20),
      max_syncs_per_storage: pickInt(by[PRESET_SETTING_KEYS.max_syncs_per_storage], WORKER_CONFIG_DEFAULTS.max_syncs_per_storage, 1, 20),
      import_batch_delay_ms: pickInt(by[PRESET_SETTING_KEYS.import_batch_delay_ms], WORKER_CONFIG_DEFAULTS.import_batch_delay_ms, 0, 5000),
    },
  };
}

export type ApplyResult = {
  preset: PresetId;
  changes: DiffRow[];
  /** perfis existentes cujos tipos/pesos/slots mudaram (precisam reiniciar para valer) */
  restartProfiles: string[];
  /** perfis criados agora (o supervisor sobe sozinho) */
  newProfiles: string[];
  warnings: string[];
};

export class UnknownPresetError extends Error {}

export async function applyPreset(presetId: string): Promise<ApplyResult> {
  const preset = getPreset(presetId);
  if (!preset) throw new UnknownPresetError(`Perfil de desempenho desconhecido: ${presetId}`);

  const { capacity: current, profiles } = await readCurrentCapacity();
  const changes = diffCapacity(current, preset.capacity);
  const byName = new Map(profiles.map((p) => [p.name, p]));

  const ops: unknown[] = [];
  const restartProfiles: string[] = [];
  const newProfiles: string[] = [];
  const finalLanes: { name: string; enabled: boolean; jobTypes: string[]; weights: number[] }[] = [];

  for (const lane of LANES) {
    const slots = preset.capacity.slots[lane.name]!;
    const want = { jobTypes: [...lane.jobTypes] as string[], weights: [...lane.weights], concurrency: slots, enabled: true };
    finalLanes.push({ name: lane.name, enabled: true, jobTypes: want.jobTypes, weights: want.weights });
    const existing = byName.get(lane.name);

    if (!existing) {
      // herda poll/memória do "irmão" mais antigo (o worker da mesma família) para não surpreender
      const sibling = byName.get(lane.family === "sync" ? "worker-sync" : "worker-uploads");
      ops.push(prisma.workerProfile.create({
        data: {
          name: lane.name, ...want,
          pollMs: sibling?.pollMs ?? PROFILE_DEFAULTS.pollMs,
          duckdbMemoryLimit: sibling?.duckdbMemoryLimit ?? PROFILE_DEFAULTS.duckdbMemoryLimit,
        },
      }));
      newProfiles.push(lane.name);
      continue;
    }

    const changed = needsRestart(existing, want);       // tipos, pesos ou slots
    if (!changed && existing.enabled) continue;
    ops.push(prisma.workerProfile.update({ where: { id: existing.id }, data: { ...want, revision: { increment: 1 } } }));
    if (changed && existing.enabled) restartProfiles.push(lane.name); // habilitar um perfil parado não exige reiniciar
  }

  for (const [field, key] of Object.entries(PRESET_SETTING_KEYS) as [keyof typeof PRESET_SETTING_KEYS, string][]) {
    ops.push(prisma.$executeRawUnsafe(
      `INSERT INTO cw_system_settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      key, String(preset.capacity[field]),
    ));
  }

  await prisma.$transaction(ops as never[]);
  invalidateWorkerConfigCache();

  // Coerência do resultado: os tetos e slots do preset + cobertura de (tipo, peso) contando os perfis fora do escopo (custom).
  const others = profiles.filter((p) => !LANE_NAMES.includes(p.name)).map((p) => ({ enabled: p.enabled, jobTypes: p.jobTypes, weights: p.weights }));
  const warnings = [
    ...validateCapacity(preset.capacity).warnings,
    ...coverageWarnings([...others, ...finalLanes]),
  ];

  return { preset: preset.id, changes, restartProfiles, newProfiles, warnings };
}
