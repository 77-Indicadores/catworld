/**
 * GET  /api/v1/settings/worker  — configurações globais do worker e limites de upload (fonte única: o banco)
 * PATCH /api/v1/settings/worker — salva
 *
 * Config POR PROCESSO (tipos de job, concorrência, poll, memória) mora nos perfis: /api/v1/worker-profiles.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { handleApiError, ok } from "@/server/http";
import {
  SUPERVISOR_DEFAULTS,
  UPLOAD_HARD_CEILING_BYTES,
  UPLOAD_LIMIT_DEFAULTS,
  WORKER_CONFIG_DEFAULTS,
  invalidateWorkerConfigCache,
  pickInt,
} from "@/server/worker/config";

const MB = 1024 * 1024;

/** campo da API -> chave em cw_system_settings, padrão e faixa. */
const FIELDS = {
  max_heavy_jobs:        { key: "worker.max_heavy_jobs",        def: WORKER_CONFIG_DEFAULTS.max_heavy_jobs,        min: 1,    max: 20 },
  max_syncs_per_storage: { key: "worker.max_syncs_per_storage", def: WORKER_CONFIG_DEFAULTS.max_syncs_per_storage, min: 1,    max: 20 },
  import_batch_delay_ms: { key: "worker.import_batch_delay_ms", def: WORKER_CONFIG_DEFAULTS.import_batch_delay_ms, min: 0,   max: 5000 },
  // Só alimenta o AVISO de memória da tela (estimativa de pico x limite do container `workers`). 0 = não informado.
  memory_limit_gb:       { key: "worker.memory_limit_gb",       def: 0,                                            min: 0,    max: 1024 },
  upload_max_bytes:      { key: "upload.max_bytes",             def: UPLOAD_LIMIT_DEFAULTS.max_bytes,              min: MB,   max: UPLOAD_HARD_CEILING_BYTES },
  upload_xlsx_max_bytes: { key: "upload.xlsx_max_bytes",        def: UPLOAD_LIMIT_DEFAULTS.xlsx_max_bytes,         min: MB,   max: UPLOAD_HARD_CEILING_BYTES },
  stop_timeout_ms:       { key: "worker.stop_timeout_ms",       def: SUPERVISOR_DEFAULTS.stop_timeout_ms,          min: 1000, max: 3_600_000 },
  backoff_max_ms:        { key: "worker.backoff_max_ms",        def: SUPERVISOR_DEFAULTS.backoff_max_ms,           min: 1000, max: 600_000 },
} as const;
type Field = keyof typeof FIELDS;

const patchSchema = z.object(
  Object.fromEntries(Object.entries(FIELDS).map(([name, f]) => [name, z.number().int().min(f.min).max(f.max).optional()])) as Record<Field, z.ZodOptional<z.ZodNumber>>,
);

async function getSettings() {
  const rows = await prisma.$queryRawUnsafe<{ key: string; value: string }[]>(
    `SELECT key, value FROM cw_system_settings WHERE key = ANY($1::text[])`,
    Object.values(FIELDS).map((f) => f.key),
  );
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const values = Object.fromEntries(
    (Object.entries(FIELDS) as [Field, (typeof FIELDS)[Field]][]).map(([name, f]) => [name, pickInt(byKey[f.key], f.def, f.min, f.max)]),
  ) as Record<Field, number>;
  return {
    ...values,
    defaults: {
      ...WORKER_CONFIG_DEFAULTS,
      memory_limit_gb: 0,
      upload_max_bytes: UPLOAD_LIMIT_DEFAULTS.max_bytes,
      upload_xlsx_max_bytes: UPLOAD_LIMIT_DEFAULTS.xlsx_max_bytes,
      stop_timeout_ms: SUPERVISOR_DEFAULTS.stop_timeout_ms,
      backoff_max_ms: SUPERVISOR_DEFAULTS.backoff_max_ms,
    },
    ranges: Object.fromEntries((Object.entries(FIELDS) as [Field, (typeof FIELDS)[Field]][]).map(([name, f]) => [name, { min: f.min, max: f.max }])),
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

    for (const [name, value] of Object.entries(body) as [Field, number | undefined][]) {
      if (value === undefined) continue;
      await prisma.$executeRawUnsafe(
        `INSERT INTO cw_system_settings (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        FIELDS[name].key,
        String(value),
      );
    }

    invalidateWorkerConfigCache();
    return ok(await getSettings());
  } catch (e) {
    return handleApiError(e);
  }
}
