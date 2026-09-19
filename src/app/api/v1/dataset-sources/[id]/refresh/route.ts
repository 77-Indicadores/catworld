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

    if (request.nextUrl.searchParams.get("action") === "cancel") {
      const { count } = await prisma.job.updateMany({
        where: { type: "SOURCE_REFRESH", status: { in: ["QUEUED", "RUNNING"] }, payloadJson: { contains: source.id } },
        data: { status: "FAILED", lastError: "Cancelado pelo usuário" },
      });
      if (count === 0) throw new ApiError(409, "NOT_CANCELLABLE", "Não há sincronização ativa para esta fonte");
      return ok({ cancelled: true });
    }

    const body = await request.json().catch(() => ({}));
    const reconciliation = body?.reconciliation === true;
    return ok(await queueSourceRefresh(source.id, { reconciliation }), undefined, 202);
  } catch (e) {
    return handleApiError(e);
  }
}
