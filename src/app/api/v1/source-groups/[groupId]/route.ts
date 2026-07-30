import { z } from "zod";
import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { resolveActor } from "@/server/auth/actor";
import { canAccess } from "@/server/auth/permissions";
import { ApiError, handleApiError, ok } from "@/server/http";
import { nextRefreshFromCron, queueSourceRefresh } from "@/server/connections/sources";
import { deleteDatasetSourceGroup } from "@/server/data/catalog";

async function authoriseGroup(request: NextRequest, groupId: string) {
  const actor = await resolveActor(request);
  const sources = await prisma.datasetSource.findMany({
    where: { sourceGroupId: groupId },
    select: { id: true, datasetId: true, dataset: { select: { projectId: true } } },
  });
  if (!sources.length) throw new ApiError(404, "GROUP_NOT_FOUND", "Grupo de fontes não encontrado");
  const { datasetId, dataset } = sources[0]!;
  if (actor.role !== "ADMIN" && !await canAccess(actor, "WRITE", dataset.projectId, datasetId)) {
    throw new ApiError(403, "FORBIDDEN", "Sem permissão para modificar estas fontes");
  }
  return { actor, sources, datasetId };
}

const patchSchema = z.object({
  mode: z.enum(["extract", "live"]).optional(),
  refreshCron: z.string().max(100).nullable().optional(),
  active: z.boolean().optional(),
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ groupId: string }> }) {
  try {
    const groupId = (await params).groupId;
    const { sources } = await authoriseGroup(request, groupId);
    const input = patchSchema.parse(await request.json());

    const effectiveCron = input.mode === "live" ? null : input.refreshCron;
    const nextAt = effectiveCron !== undefined
      ? (effectiveCron ? nextRefreshFromCron(effectiveCron) : null)
      : undefined;

    await prisma.datasetSource.updateMany({
      where: { sourceGroupId: groupId },
      data: {
        ...(input.mode !== undefined ? { mode: input.mode } : {}),
        ...(effectiveCron !== undefined ? { refreshCron: effectiveCron } : {}),
        ...(input.mode === "live" ? { refreshCron: null, nextRefreshAt: null } : {}),
        ...(nextAt !== undefined && input.mode !== "live" ? { nextRefreshAt: nextAt } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
      },
    });

    if (input.active === true) {
      for (const s of sources) await queueSourceRefresh(s.id).catch(() => undefined);
    }

    return ok({ updated: sources.length });
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ groupId: string }> }) {
  try {
    const groupId = (await params).groupId;
    await authoriseGroup(request, groupId);
    return ok(await deleteDatasetSourceGroup(groupId));
  } catch (e) {
    return handleApiError(e);
  }
}
