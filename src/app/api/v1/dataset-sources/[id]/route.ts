import { z } from "zod";
import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { resolveActor } from "@/server/auth/actor";
import { canAccess } from "@/server/auth/permissions";
import { ApiError, handleApiError, ok } from "@/server/http";
import { assertValidCron, nextRefreshFromCron } from "@/server/connections/sources";
import { deleteDatasetSource } from "@/server/data/catalog";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(request);
    const id = (await params).id;
    const source = await prisma.datasetSource.findUniqueOrThrow({
      where: { id },
      include: { connection: { select: { id: true, name: true, provider: true } }, dataset: { select: { projectId: true } } },
    });
    if (actor.role !== "ADMIN" && !await canAccess(actor, "READ", source.dataset.projectId, source.datasetId)) {
      throw new ApiError(403, "FORBIDDEN", "Sem permissão para ler esta fonte");
    }
    return ok(source);
  } catch (e) {
    return handleApiError(e);
  }
}

const patchSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  mode: z.enum(["extract", "live"]).optional(),
  refreshCron: z.string().max(100).nullable().optional(),
  keyColumn: z.string().max(128).nullable().optional(),
  deltaColumn: z.string().max(128).nullable().optional(),
  sourceSql: z.string().min(1).nullable().optional(),
  reconciliationCron: z.string().max(100).nullable().optional(),
  sourceSqlReconciliation: z.string().min(1).nullable().optional(),
  active: z.boolean().optional(),
});

async function authorise(request: NextRequest, id: string) {
  const actor = await resolveActor(request);
  const source = await prisma.datasetSource.findUniqueOrThrow({
    where: { id },
    select: { datasetId: true, sourceKind: true, mode: true, reconciliationCron: true, sourceSqlReconciliation: true, dataset: { select: { projectId: true } } },
  });
  if (actor.role !== "ADMIN" && !await canAccess(actor, "WRITE", source.dataset.projectId, source.datasetId)) {
    throw new ApiError(403, "FORBIDDEN", "Sem permissão para modificar esta fonte");
  }
  return { actor, source };
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = (await params).id;
    const { source } = await authorise(request, id);
    const input = patchSchema.parse(await request.json());

    assertValidCron(input.refreshCron, "refreshCron");
    assertValidCron(input.reconciliationCron, "reconciliationCron");
    const effectiveCron = input.mode === "live" ? null : input.refreshCron;
    const nextAt = effectiveCron !== undefined
      ? (effectiveCron ? nextRefreshFromCron(effectiveCron) : null)
      : undefined;

    const effectiveReconciliationCron = input.mode === "live" ? null : input.reconciliationCron;
    const effectiveReconciliationSql = input.sourceSqlReconciliation !== undefined ? input.sourceSqlReconciliation : source.sourceSqlReconciliation;
    // Valida contra o estado resultante (mesclado): PATCH {sourceSqlReconciliation:null}
    // com cron ja gravado tambem precisa falhar.
    const resultingMode = input.mode ?? source.mode;
    const resultingReconciliationCron = resultingMode === "live"
      ? null
      : (input.reconciliationCron !== undefined ? input.reconciliationCron : source.reconciliationCron);
    if (resultingReconciliationCron?.trim() && source.sourceKind === "query" && !effectiveReconciliationSql?.trim()) {
      throw new ApiError(400, "RECONCILIATION_SQL_REQUIRED", "Fontes por consulta exigem uma consulta de reconciliacao (sem filtro de data) para habilitar o cron de reconciliacao");
    }
    const nextReconciliationAt = effectiveReconciliationCron !== undefined
      ? (effectiveReconciliationCron ? nextRefreshFromCron(effectiveReconciliationCron) : null)
      : undefined;

    return ok(await prisma.datasetSource.update({
      where: { id },
      data: {
        ...input,
        ...(effectiveCron !== undefined ? { refreshCron: effectiveCron, nextRefreshAt: nextAt } : {}),
        ...(input.mode === "live" ? { refreshCron: null, nextRefreshAt: null } : {}),
        ...(effectiveReconciliationCron !== undefined ? { reconciliationCron: effectiveReconciliationCron, nextReconciliationAt } : {}),
        ...(input.mode === "live" ? { reconciliationCron: null, nextReconciliationAt: null } : {}),
      },
    }));
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = (await params).id;
    await authorise(request, id);
    await deleteDatasetSource(id);
    return ok({ deleted: true });
  } catch (e) {
    return handleApiError(e);
  }
}
