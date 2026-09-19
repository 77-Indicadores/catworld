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

/** Inteiro dentro de [min,max]; qualquer outra coisa devolve o fallback. */
export function pickInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

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

  const map = Object.fromEntries(rows.map((r) => [r.key.replace("worker.", ""), r.value]));
  const e = env();

  // Valor invalido no banco (texto, NaN, fora da faixa da API) nao pode virar NaN/0 e travar o worker: cai no env.
  const value: WorkerConfig = {
    maxHeavyJobs:        pickInt(map["max_heavy_jobs"], e.CATWORLD_MAX_HEAVY_JOBS, 1, 20),
    maxSyncsPerStorage:  pickInt(map["max_syncs_per_storage"], e.CATWORLD_MAX_SYNCS_PER_STORAGE, 1, 20),
    importBatchDelayMs:  pickInt(map["import_batch_delay_ms"], e.CATWORLD_IMPORT_BATCH_DELAY_MS, 0, 5000),
  };

  _cache = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

/** Invalida o cache local (usar após salvar novas configs). */
export function invalidateWorkerConfigCache() {
  _cache = null;
}
