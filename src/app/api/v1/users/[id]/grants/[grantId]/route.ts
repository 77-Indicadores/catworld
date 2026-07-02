import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { grantTargets, invalidateSyncCache } from "@/server/auth/sync-grants";
import { revokeSchema } from "@/server/azure/sql";
import { ApiError, handleApiError, ok } from "@/server/http";

export async function DELETE(r: NextRequest, { params }: { params: Promise<{ id: string; grantId: string }> }) {
  try {
    const actor = await resolveActor(r);
    requireRole(actor, ["ADMIN"]);
    const { id: userId, grantId } = await params;
    const grant = await prisma.accessGrant.findUniqueOrThrow({ where: { id: grantId } });
    if (grant.userId !== userId) throw new ApiError(404, "NOT_FOUND", "Acesso não encontrado para este usuário");
    const targets = await grantTargets(grant);
    await prisma.accessGrant.delete({ where: { id: grantId } });
    const remaining = await prisma.accessGrant.findMany({ where: { userId } });
    const principal = `cw_u_${userId.replaceAll("-", "").slice(0, 24)}`;
    for (const dataset of targets) {
      const stillGranted = remaining.some((g) => g.scopeType === "GLOBAL" || (g.scopeType === "PROJECT" && g.projectId === dataset.projectId) || (g.scopeType === "DATASET" && g.datasetId === dataset.id));
      if (!stillGranted) await revokeSchema(principal, dataset.schemaName);
    }
    invalidateSyncCache(principal);
    return ok({ revoked: true });
  } catch (e) {
    return handleApiError(e);
  }
}
