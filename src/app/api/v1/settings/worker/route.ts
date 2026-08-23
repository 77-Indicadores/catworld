/**
 * GET  /api/v1/settings/worker  — retorna configurações de performance do worker
 * PATCH /api/v1/settings/worker — salva configurações
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { handleApiError, ok } from "@/server/http";
import { WORKER_CONFIG_DEFAULTS, invalidateWorkerConfigCache } from "@/server/worker/config";
import { env } from "@/server/env";

const KEYS = [
  "worker.max_heavy_jobs",
  "worker.max_syncs_per_storage",
  "worker.import_batch_delay_ms",
] as const;

const patchSchema = z.object({
  max_heavy_jobs:        z.number().int().min(1).max(20).optional(),
  max_syncs_per_storage: z.number().int().min(1).max(20).optional(),
  import_batch_delay_ms: z.number().int().min(0).max(5000).optional(),
});

type Row = { key: string; value: string };

async function getSettings() {
  const rows = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT key, value FROM cw_system_settings WHERE key = ANY($1::text[])`,
    KEYS,
  );
  const map = Object.fromEntries(rows.map((r) => [r.key.replace("worker.", ""), Number(r.value)]));
  const e = env();
  return {
    max_heavy_jobs:        map["max_heavy_jobs"]        ?? e.CATWORLD_MAX_HEAVY_JOBS,
    max_syncs_per_storage: map["max_syncs_per_storage"] ?? e.CATWORLD_MAX_SYNCS_PER_STORAGE,
    import_batch_delay_ms: map["import_batch_delay_ms"] ?? e.CATWORLD_IMPORT_BATCH_DELAY_MS,
    // Concorrência vem só do env (requer restart)
    concurrency: e.CATWORLD_WORKER_CONCURRENCY,
    defaults: WORKER_CONFIG_DEFAULTS,
  };
}

export async function GET(r: NextRequest) {
  try {
    const actor = await resolveActor(r);
    requireRole(actor, ["ADMIN"]);
    return ok(await getSettings());
  } catch (e) {
    return handleApiError(e);
  }
}

export async function PATCH(r: NextRequest) {
  try {
    const actor = await resolveActor(r);
    requireRole(actor, ["ADMIN"]);
    const body = patchSchema.parse(await r.json());

    const updates: [string, number][] = [
      ...(body.max_heavy_jobs        !== undefined ? [["worker.max_heavy_jobs",        body.max_heavy_jobs]        as [string, number]] : []),
      ...(body.max_syncs_per_storage !== undefined ? [["worker.max_syncs_per_storage", body.max_syncs_per_storage] as [string, number]] : []),
      ...(body.import_batch_delay_ms !== undefined ? [["worker.import_batch_delay_ms", body.import_batch_delay_ms] as [string, number]] : []),
    ];

    for (const [key, value] of updates) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO cw_system_settings (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        key,
        String(value),
      );
    }

    invalidateWorkerConfigCache();
    return ok(await getSettings());
  } catch (e) {
    return handleApiError(e);
  }
}
