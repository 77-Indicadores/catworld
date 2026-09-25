/**
 * POST /api/v1/datasets/[id]/migrate-storage
 *
 * Enfileira a migracao de um dataset para outro StorageServer (MIGRATE_STORAGE_DATASET,
 * processado em background pelo worker — ver src/worker/index.ts e src/server/storage/migrate.ts).
 * Suporta cross-provider (sqlserver <-> postgres) — antes desta versao, a copia era feita aqui
 * mesmo via mssql cru e so funcionava SQL Server -> SQL Server; agora reusa a mesma
 * implementacao (StorageConnection) da migracao por projeto, com tipagem correta na copia
 * (a versao anterior gravava tudo como NVARCHAR(MAX), perdendo fidelidade de tipo).
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
    const id = (await params).id;
    const { targetStorageServerId } = bodySchema.parse(await r.json());

    const dataset = await prisma.dataset.findUniqueOrThrow({
      where: { id },
      select: { id: true, name: true, projectId: true, storageServerId: true },
    });
    if (dataset.storageServerId === targetStorageServerId) {
      throw new ApiError(400, "SAME_SERVER", "Dataset já está neste servidor");
    }

    // Lock por dataset: sem isso, dois cliques rápidos (ou duas abas) veem "nenhum job ativo" ao
    // mesmo tempo e ambos criam um job — dois workers copiando pra mesma tabela de destino ao mesmo
    // tempo corrompe a cópia (um dropa/recria enquanto o outro ainda lê/escreve).
    const job = await withAdvisoryLock(id, async () => {
      const conflict = await findActiveMigrationConflict({ datasetId: id, projectId: dataset.projectId });
      if (conflict) {
        throw new ApiError(409, "MIGRATION_IN_PROGRESS", "Já existe uma migração de storage em andamento para este dataset (ou para o projeto inteiro)");
      }
      return prisma.job.create({
        data: {
          type: "MIGRATE_STORAGE_DATASET",
          weight: 2,
          payloadJson: JSON.stringify({ datasetId: id, targetStorageServerId, datasetName: dataset.name }),
        },
      });
    });

    return ok({ jobId: job.id }, undefined, 202);
  } catch (e) {
    return handleApiError(e);
  }
}
