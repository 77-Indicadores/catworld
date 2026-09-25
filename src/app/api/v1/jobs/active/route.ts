/**
 * GET /api/v1/jobs/active
 *
 * Jobs de "operacao pesada em background" ainda ativos (QUEUED/RUNNING), para um indicador
 * global no layout — nao a tela de /uploads, que fica so com PREVIEW_UPLOAD/IMPORT_UPLOAD/
 * SOURCE_REFRESH (ver src/app/uploads/page.tsx). Hoje so cobre migracao de storage; qualquer
 * job pesado futuro que nao deva aparecer numa tela dedicada entra nesse mesmo tipo de lista.
 */
import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { handleApiError, ok } from "@/server/http";

const BACKGROUND_JOB_TYPES = ["MIGRATE_STORAGE_PROJECT", "MIGRATE_STORAGE_DATASET"] as const;

type MigratePayload = { projectId?: string; projectName?: string; datasetId?: string; datasetName?: string; targetStorageServerId?: string };

export async function GET(r: NextRequest) {
  try {
    const actor = await resolveActor(r);
    requireRole(actor, ["ADMIN"]);

    const jobs = await prisma.job.findMany({
      where: { type: { in: [...BACKGROUND_JOB_TYPES] }, status: { in: ["QUEUED", "RUNNING"] } },
      select: { id: true, type: true, status: true, payloadJson: true, attempts: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });

    const items = jobs.map(j => {
      const payload = j.payloadJson ? (JSON.parse(j.payloadJson) as MigratePayload) : {};
      const label = j.type === "MIGRATE_STORAGE_PROJECT"
        ? `Migrando projeto "${payload.projectName ?? payload.projectId ?? "?"}"`
        : `Migrando dataset "${payload.datasetName ?? payload.datasetId ?? "?"}"`;
      return { id: j.id, type: j.type, status: j.status, label, attempts: j.attempts, createdAt: j.createdAt };
    });

    return ok({ jobs: items });
  } catch (e) {
    return handleApiError(e);
  }
}
