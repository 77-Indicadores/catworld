/**
 * GET /api/v1/settings/retention/history — retorna as últimas execuções do METADATA_CLEANUP
 */
import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { handleApiError, ok } from "@/server/http";

export async function GET(r: NextRequest) {
  try {
    const actor = await resolveActor(r);
    requireRole(actor, ["ADMIN"]);

    const runs = await prisma.$queryRawUnsafe<{
      id: string;
      started_at: Date;
      finished_at: Date | null;
      duration_ms: number | null;
      deleted_jobs: number;
      deleted_audit: number;
      deleted_uploads: number;
      deleted_files: number;
      deleted_orphans: number;
      deleted_versions: number;
      error: string | null;
    }[]>(
      `SELECT id, started_at, finished_at, duration_ms,
              deleted_jobs, deleted_audit, deleted_uploads,
              deleted_files, deleted_orphans, deleted_versions, error
       FROM cw_cleanup_runs
       ORDER BY started_at DESC
       LIMIT 20`,
    );

    return ok(runs);
  } catch (e) {
    return handleApiError(e);
  }
}
