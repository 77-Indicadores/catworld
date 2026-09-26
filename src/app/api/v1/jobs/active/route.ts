/**
 * GET /api/v1/jobs/active
 *
 * Jobs de "operacao pesada em background" ainda ativos (QUEUED/RUNNING), para um indicador
 * global no layout — nao a tela de /uploads, que fica so com PREVIEW_UPLOAD/IMPORT_UPLOAD/
 * SOURCE_REFRESH (ver src/app/uploads/page.tsx). Hoje so cobre migracao de storage; qualquer
 * job pesado futuro que nao deva aparecer numa tela dedicada entra nesse mesmo tipo de lista.
 *
 * Tambem inclui falhas RECENTES (24h): sem isso, uma migracao que esgota as tentativas some
 * do indicador assim que vira FAILED, e como nao existe historico/toast para esse tipo de job,
 * o admin que fechou o dialogo de "acompanhe pelo indicador" nunca fica sabendo que falhou.
 */
import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { handleApiError, ok } from "@/server/http";

const BACKGROUND_JOB_TYPES = ["MIGRATE_STORAGE_PROJECT", "MIGRATE_STORAGE_DATASET"] as const;
const RECENT_FAILURE_WINDOW_MS = 24 * 3_600_000;

type MigratePayload = { projectId?: string; projectName?: string; datasetId?: string; datasetName?: string; targetStorageServerId?: string };

export async function GET(r: NextRequest) {
  try {
    const actor = await resolveActor(r);
    requireRole(actor, ["ADMIN"]);

    const jobs = await prisma.job.findMany({
      where: {
        type: { in: [...BACKGROUND_JOB_TYPES] },
        OR: [
          { status: { in: ["QUEUED", "RUNNING"] } },
          { status: "FAILED", updatedAt: { gt: new Date(Date.now() - RECENT_FAILURE_WINDOW_MS) } },
        ],
      },
      select: { id: true, type: true, status: true, payloadJson: true, attempts: true, createdAt: true, lastError: true },
      orderBy: { createdAt: "asc" },
    });

    const items = jobs.map(j => {
      const payload = j.payloadJson ? (JSON.parse(j.payloadJson) as MigratePayload) : {};
      const label = j.type === "MIGRATE_STORAGE_PROJECT"
        ? `Migrando projeto "${payload.projectName ?? payload.projectId ?? "?"}"`
        : `Migrando dataset "${payload.datasetName ?? payload.datasetId ?? "?"}"`;
      return { id: j.id, type: j.type, status: j.status, label, attempts: j.attempts, createdAt: j.createdAt, lastError: j.status === "FAILED" ? j.lastError : null };
    });

    return ok({ jobs: items });
  } catch (e) {
    return handleApiError(e);
  }
}
