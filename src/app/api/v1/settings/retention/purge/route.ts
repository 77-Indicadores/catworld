/**
 * POST /api/v1/settings/retention/purge — enfileira um job de limpeza imediata
 */
import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { handleApiError, ok } from "@/server/http";

export async function POST(r: NextRequest) {
  try {
    const actor = await resolveActor(r);
    requireRole(actor, ["ADMIN"]);

    // INSERT atômico — evita duplicar se já há um QUEUED/RUNNING
    const inserted = await prisma.$executeRawUnsafe(
      `INSERT INTO cw_jobs (id, type, status, payload_json, attempts, max_attempts, weight, available_at, created_at, updated_at)
       SELECT gen_random_uuid(), 'METADATA_CLEANUP', 'QUEUED', NULL, 0, 1, 0, NOW(), NOW(), NOW()
       WHERE NOT EXISTS (
         SELECT 1 FROM cw_jobs WHERE type = 'METADATA_CLEANUP' AND status IN ('QUEUED', 'RUNNING')
       )`,
    );

    return ok({ queued: inserted > 0 });
  } catch (e) {
    return handleApiError(e);
  }
}
