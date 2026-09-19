/**
 * Configuração de performance do worker e limites de upload.
 *
 * Fonte única: o banco (`cw_system_settings`, editado em Configurações > Worker). Sem valor salvo ou com valor
 * inválido vale o PADRÃO DO CÓDIGO — nenhuma variável de ambiente entra aqui, nem como fallback.
 * Relido a cada job/ciclo (cache de 10 s) para reagir a mudanças sem reiniciar.
 */

import { prisma } from "@/server/db";

export type WorkerConfig = {
  maxHeavyJobs: number;
  maxSyncsPerStorage: number;
  importBatchDelayMs: number;
};

export type UploadLimits = {
  maxBytes: number;
  xlsxMaxBytes: number;
};

const KEYS = [
  "worker.max_heavy_jobs",
  "worker.max_syncs_per_storage",
  "worker.import_batch_delay_ms",
] as const;

const UPLOAD_KEYS = ["upload.max_bytes", "upload.xlsx_max_bytes"] as const;

export const WORKER_CONFIG_DEFAULTS = {
  max_heavy_jobs:         2,
  max_syncs_per_storage:  3,
  import_batch_delay_ms:  200,
} as const;

// XLSX é lido inteiro em memória (ExcelJS, ~35x o tamanho do arquivo): 100MB se mostrou perigoso em produção.
export const UPLOAD_LIMIT_DEFAULTS = {
  max_bytes:      500 * 1024 * 1024,
  xlsx_max_bytes: 40 * 1024 * 1024,
} as const;

/** Tempos do supervisor (reinício seguro e backoff de filho que cai). */
export const SUPERVISOR_DEFAULTS = {
  stop_timeout_ms: 10 * 60 * 1000,
  backoff_max_ms:  60 * 1000,
} as const;

/** Teto absoluto aceito para os limites de upload (o proxy do Next usa o mesmo valor, ver next.config.ts). */
export const UPLOAD_HARD_CEILING_BYTES = 2 * 1024 * 1024 * 1024;

/** Inteiro dentro de [min,max]; qualquer outra coisa devolve o fallback. */
export function pickInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

type Cached<T> = { value: T; expiresAt: number } | null;
const CACHE_TTL_MS = 10_000; // relê a cada 10s no máximo
let _cache: Cached<WorkerConfig> = null;
let _uploadCache: Cached<UploadLimits> = null;

async function readSettings(keys: readonly string[]): Promise<Record<string, string>> {
  try {
    const rows = await prisma.$queryRawUnsafe<{ key: string; value: string }[]>(
      `SELECT key, value FROM cw_system_settings WHERE key = ANY($1::text[])`,
      keys,
    );
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch {
    return {}; // banco indisponível: vale o padrão do código
  }
}

export async function getWorkerConfig(): Promise<WorkerConfig> {
  const now = Date.now();
  if (_cache && now < _cache.expiresAt) return _cache.value;
  const map = await readSettings(KEYS);
  // Valor inválido no banco (texto, NaN, fora da faixa da API) não pode virar NaN/0 e travar o worker: cai no padrão.
  const value: WorkerConfig = {
    maxHeavyJobs:       pickInt(map["worker.max_heavy_jobs"], WORKER_CONFIG_DEFAULTS.max_heavy_jobs, 1, 20),
    maxSyncsPerStorage: pickInt(map["worker.max_syncs_per_storage"], WORKER_CONFIG_DEFAULTS.max_syncs_per_storage, 1, 20),
    importBatchDelayMs: pickInt(map["worker.import_batch_delay_ms"], WORKER_CONFIG_DEFAULTS.import_batch_delay_ms, 0, 5000),
  };
  _cache = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

export async function getUploadLimits(): Promise<UploadLimits> {
  const now = Date.now();
  if (_uploadCache && now < _uploadCache.expiresAt) return _uploadCache.value;
  const map = await readSettings(UPLOAD_KEYS);
  const value: UploadLimits = {
    maxBytes:     pickInt(map["upload.max_bytes"], UPLOAD_LIMIT_DEFAULTS.max_bytes, 1024 * 1024, UPLOAD_HARD_CEILING_BYTES),
    xlsxMaxBytes: pickInt(map["upload.xlsx_max_bytes"], UPLOAD_LIMIT_DEFAULTS.xlsx_max_bytes, 1024 * 1024, UPLOAD_HARD_CEILING_BYTES),
  };
  _uploadCache = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

/** Invalida o cache local (usar após salvar novas configs). */
export function invalidateWorkerConfigCache() {
  _cache = null;
  _uploadCache = null;
}
