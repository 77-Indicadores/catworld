/**
 * GET  /api/v1/settings/retention  — retorna as configurações de retenção atuais
 * PATCH /api/v1/settings/retention — atualiza uma ou mais configurações
 *
 * Usa $queryRawUnsafe para evitar dependência do Prisma client gerado
 * (o model SystemSetting está no schema mas o client pode não ter sido regenerado ainda).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { handleApiError, ok } from "@/server/http";

const KEYS = [
  "retention.jobs_days",
  "retention.audit_events_days",
  "retention.uploads_days",
  "retention.dataset_versions_keep",
  "retention.upload_files_days",
] as const;

const DEFAULTS = {
  "retention.jobs_days":             30,
  "retention.audit_events_days":     30,
  "retention.uploads_days":          30,
  "retention.dataset_versions_keep": 10,
  "retention.upload_files_days":     30,
} as const;

const patchSchema = z.object({
  jobs_days:             z.number().int().min(1).max(3650).optional(),
  audit_events_days:     z.number().int().min(1).max(3650).optional(),
  uploads_days:          z.number().int().min(1).max(3650).optional(),
  dataset_versions_keep: z.number().int().min(1).max(1000).optional(),
  /** dias que o arquivo original de um upload concluído fica guardado; 0 = não guardar */
  upload_files_days:     z.number().int().min(0).max(3650).optional(),
});

type Row = { key: string; value: string };

async function getSettings() {
  const rows = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT key, value FROM cw_system_settings WHERE key = ANY($1::text[])`,
    KEYS,
  );
  const map = Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]));
  return {
    jobs_days:             map["retention.jobs_days"]             ?? DEFAULTS["retention.jobs_days"],
    audit_events_days:     map["retention.audit_events_days"]     ?? DEFAULTS["retention.audit_events_days"],
    uploads_days:          map["retention.uploads_days"]          ?? DEFAULTS["retention.uploads_days"],
    dataset_versions_keep: map["retention.dataset_versions_keep"] ?? DEFAULTS["retention.dataset_versions_keep"],
    upload_files_days:     map["retention.upload_files_days"]     ?? DEFAULTS["retention.upload_files_days"],
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
      ...(body.jobs_days             !== undefined ? [["retention.jobs_days",             body.jobs_days]             as [string, number]] : []),
      ...(body.audit_events_days     !== undefined ? [["retention.audit_events_days",     body.audit_events_days]     as [string, number]] : []),
      ...(body.uploads_days          !== undefined ? [["retention.uploads_days",          body.uploads_days]          as [string, number]] : []),
      ...(body.dataset_versions_keep !== undefined ? [["retention.dataset_versions_keep", body.dataset_versions_keep] as [string, number]] : []),
      ...(body.upload_files_days     !== undefined ? [["retention.upload_files_days",     body.upload_files_days]     as [string, number]] : []),
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

    return ok(await getSettings());
  } catch (e) {
    return handleApiError(e);
  }
}
