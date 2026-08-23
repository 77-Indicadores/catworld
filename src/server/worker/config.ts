/**
 * getWorkerConfig — lê configurações de performance do worker.
 *
 * Prioridade: cw_system_settings (painel) > variáveis de ambiente > defaults.
 * Chamado a cada job/ciclo para reagir a mudanças sem restart.
 */

import { prisma } from "@/server/db";
import { env } from "@/server/env";

export type WorkerConfig = {
  maxHeavyJobs: number;
  maxSyncsPerStorage: number;
  importBatchDelayMs: number;
};

const KEYS = [
  "worker.max_heavy_jobs",
  "worker.max_syncs_per_storage",
  "worker.import_batch_delay_ms",
] as const;

export const WORKER_CONFIG_DEFAULTS = {
  max_heavy_jobs:         2,
  max_syncs_per_storage:  3,
  import_batch_delay_ms:  200,
} as const;

let _cache: { value: WorkerConfig; expiresAt: number } | null = null;
const CACHE_TTL_MS = 10_000; // relê a cada 10s no máximo

export async function getWorkerConfig(): Promise<WorkerConfig> {
  const now = Date.now();
  if (_cache && now < _cache.expiresAt) return _cache.value;

  let rows: { key: string; value: string }[] = [];
  try {
    rows = await prisma.$queryRawUnsafe<{ key: string; value: string }[]>(
      `SELECT key, value FROM cw_system_settings WHERE key = ANY($1::text[])`,
      KEYS,
    );
  } catch {
    // banco indisponível — usa env como fallback
  }

  const map = Object.fromEntries(rows.map((r) => [r.key.replace("worker.", ""), Number(r.value)]));
  const e = env();

  const value: WorkerConfig = {
    maxHeavyJobs:        map["max_heavy_jobs"]        ?? e.CATWORLD_MAX_HEAVY_JOBS,
    maxSyncsPerStorage:  map["max_syncs_per_storage"] ?? e.CATWORLD_MAX_SYNCS_PER_STORAGE,
    importBatchDelayMs:  map["import_batch_delay_ms"] ?? e.CATWORLD_IMPORT_BATCH_DELAY_MS,
  };

  _cache = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

/** Invalida o cache local (usar após salvar novas configs). */
export function invalidateWorkerConfigCache() {
  _cache = null;
}
