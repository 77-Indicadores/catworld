/**
 * POST /api/v1/projects/[id]/migrate-storage
 *
 * Enfileira a migracao de todos os datasets do projeto para um StorageServer de destino
 * (MIGRATE_STORAGE_PROJECT, processado em background pelo worker — ver src/worker/index.ts
 * e src/server/storage/migrate.ts). Suporta cross-provider (sqlserver <-> postgres).
 * Nao remove dados da origem. So retorna o jobId; acompanhamento e via /api/v1/jobs/active.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { handleApiError, ok, ApiError } from "@/server/http";
import { withAdvisoryLock } from "@/server/db/advisory-lock";
import { findActiveMigrationConflict } from "@/server/storage/migrate";

const bodySchema = z.object({ targetStorageServerId: z.string().uuid() });

export async function POST(r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(r);
    requireRole(actor, ["ADMIN"]);
    const projectId = (await params).id;
    const { targetStorageServerId } = bodySchema.parse(await r.json());

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        name: true,
        datasets: { where: { active: true }, select: { id: true, storageServerId: true } },
      },
    });
    if (!project) throw new ApiError(404, "NOT_FOUND", "Projeto não encontrado");
    if (!project.datasets.some(d => d.storageServerId !== targetStorageServerId)) {
      throw new ApiError(400, "ALREADY_ON_TARGET", "Todos os datasets já estão neste servidor");
    }

    // Lock por projeto: evita duas migrações de projeto simultâneas (mesmo risco de corrupção por
    // corrida que no endpoint de dataset — ver comentário lá).
    const job = await withAdvisoryLock(projectId, async () => {
      const conflict = await findActiveMigrationConflict({ projectId, datasetIds: project.datasets.map(d => d.id) });
      if (conflict) {
        throw new ApiError(409, "MIGRATION_IN_PROGRESS", "Já existe uma migração de storage em andamento para este projeto (ou para algum dataset dele)");
      }
      return prisma.job.create({
        data: {
          type: "MIGRATE_STORAGE_PROJECT",
          weight: 2,
          payloadJson: JSON.stringify({ projectId, targetStorageServerId, projectName: project.name }),
        },
      });
    });

    return ok({ jobId: job.id }, undefined, 202);
  } catch (e) {
    return handleApiError(e);
  }
}
