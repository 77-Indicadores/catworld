/**
 * GET  /api/v1/settings/retention  — retorna as configurações de retenção atuais
 * PATCH /api/v1/settings/retention — atualiza uma ou mais configurações
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
] as const;

const DEFAULTS: Record<(typeof KEYS)[number], number> = {
  "retention.jobs_days": 30,
  "retention.audit_events_days": 30,
  "retention.uploads_days": 30,
  "retention.dataset_versions_keep": 10,
};

const patchSchema = z.object({
  jobs_days:              z.number().int().min(1).max(3650).optional(),
  audit_events_days:      z.number().int().min(1).max(3650).optional(),
  uploads_days:           z.number().int().min(1).max(3650).optional(),
  dataset_versions_keep:  z.number().int().min(1).max(1000).optional(),
});

async function getSettings() {
  const rows = await prisma.systemSetting.findMany({ where: { key: { in: [...KEYS] } } });
  const map = Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]));
  return {
    jobs_days:             map["retention.jobs_days"]             ?? DEFAULTS["retention.jobs_days"],
    audit_events_days:     map["retention.audit_events_days"]     ?? DEFAULTS["retention.audit_events_days"],
    uploads_days:          map["retention.uploads_days"]          ?? DEFAULTS["retention.uploads_days"],
    dataset_versions_keep: map["retention.dataset_versions_keep"] ?? DEFAULTS["retention.dataset_versions_keep"],
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

    const upserts = Object.entries({
      ...(body.jobs_days             !== undefined ? { "retention.jobs_days": body.jobs_days }                         : {}),
      ...(body.audit_events_days     !== undefined ? { "retention.audit_events_days": body.audit_events_days }         : {}),
      ...(body.uploads_days          !== undefined ? { "retention.uploads_days": body.uploads_days }                   : {}),
      ...(body.dataset_versions_keep !== undefined ? { "retention.dataset_versions_keep": body.dataset_versions_keep } : {}),
    });

    await prisma.$transaction(
      upserts.map(([key, value]) =>
        prisma.systemSetting.upsert({
          where:  { key },
          create: { key, value: String(value) },
          update: { value: String(value) },
        }),
      ),
    );

    return ok(await getSettings());
  } catch (e) {
    return handleApiError(e);
  }
}
