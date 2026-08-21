/**
 * POST /api/v1/settings/retention/purge — enfileira um job de limpeza imediata
 */
import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { handleApiError, ok } from "@/server/http";
import { randomUUID } from "crypto";

export async function POST(r: NextRequest) {
  try {
    const actor = await resolveActor(r);
    requireRole(actor, ["ADMIN"]);

    // Enqueue a METADATA_CLEANUP job (weight 0, single attempt)
    await prisma.$executeRawUnsafe(
      `INSERT INTO cw_jobs (id, type, status, payload_json, attempts, max_attempts, weight, available_at, created_at, updated_at)
       VALUES ($1, 'METADATA_CLEANUP', 'QUEUED', NULL, 0, 1, 0, NOW(), NOW(), NOW())
       ON CONFLICT DO NOTHING`,
      randomUUID(),
    );

    return ok({ queued: true });
  } catch (e) {
    return handleApiError(e);
  }
}
