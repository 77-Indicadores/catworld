import { z } from "zod";
import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { resolveActor } from "@/server/auth/actor";
import { canAccess } from "@/server/auth/permissions";
import { ApiError, handleApiError, ok } from "@/server/http";
import { nextRefresh, queueSourceRefresh } from "@/server/connections/sources";

async function authoriseGroup(request: NextRequest, groupId: string) {
  const actor = await resolveActor(request);
  const sources = await prisma.datasetSource.findMany({
    where: { sourceGroupId: groupId, active: true },
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
  refreshPolicy: z.enum(["manual", "hourly", "daily", "weekly"]).optional(),
  active: z.boolean().optional(),
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ groupId: string }> }) {
  try {
    const groupId = (await params).groupId;
    const { sources } = await authoriseGroup(request, groupId);
    const input = patchSchema.parse(await request.json());

    const effectivePolicy = input.mode === "live" ? "manual" : input.refreshPolicy;
    const nextAt = effectivePolicy && effectivePolicy !== "manual"
      ? nextRefresh(effectivePolicy)
      : effectivePolicy === "manual" ? null : undefined;

    await prisma.datasetSource.updateMany({
      where: { sourceGroupId: groupId, active: true },
      data: {
        ...(input.mode !== undefined ? { mode: input.mode } : {}),
        ...(input.mode === "live" ? { refreshPolicy: "manual", nextRefreshAt: null } : {}),
        ...(effectivePolicy !== undefined && input.mode !== "live" ? { refreshPolicy: effectivePolicy } : {}),
        ...(nextAt !== undefined && input.mode !== "live" ? { nextRefreshAt: nextAt } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
      },
    });

    // If activating extract sources, queue refresh for each
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

    // Cancel queued jobs
    const sources = await prisma.datasetSource.findMany({
      where: { sourceGroupId: groupId },
      select: { id: true },
    });
    for (const s of sources) {
      await prisma.job.updateMany({
        where: { type: "SOURCE_REFRESH", status: "QUEUED", payloadJson: JSON.stringify({ datasetSourceId: s.id }) },
        data: { status: "FAILED", lastError: "Fonte removida" },
      });
    }

    await prisma.datasetSource.updateMany({
      where: { sourceGroupId: groupId },
      data: { active: false },
    });

    return ok({ deleted: sources.length });
  } catch (e) {
    return handleApiError(e);
  }
}
