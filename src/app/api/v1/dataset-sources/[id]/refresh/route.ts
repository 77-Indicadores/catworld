import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { resolveActor } from "@/server/auth/actor";
import { canAccess } from "@/server/auth/permissions";
import { ApiError, handleApiError, ok } from "@/server/http";
import { queueSourceRefresh } from "@/server/connections/sources";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(request);
    const source = await prisma.datasetSource.findUniqueOrThrow({ where: { id: (await params).id }, include: { dataset: true } });
    if (!await canAccess(actor, "WRITE", source.dataset.projectId, source.datasetId) && actor.role !== "ADMIN") throw new ApiError(403, "FORBIDDEN", "Sem permissao para atualizar a fonte");
    return ok(await queueSourceRefresh(source.id), undefined, 202);
  } catch (e) {
    return handleApiError(e);
  }
}
