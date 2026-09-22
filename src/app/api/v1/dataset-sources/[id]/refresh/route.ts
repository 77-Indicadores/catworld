import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { resolveActor } from "@/server/auth/actor";
import { canAccess } from "@/server/auth/permissions";
import { ApiError, handleApiError, ok } from "@/server/http";
import { queueSourceRefresh } from "@/server/connections/sources";
import { audit } from "@/server/audit";

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

    if (!source.active) throw new ApiError(404, "SOURCE_NOT_FOUND", "Fonte nao encontrada");
    if (source.mode !== "extract") throw new ApiError(400, "INVALID_SOURCE_MODE", "Apenas fontes extract podem ser atualizadas");
    const body = await request.json().catch(() => ({}));
    const reconciliation = body?.reconciliation === true;
    // Atualizacao pedida por uma pessoa: nao e "agendada" (queda grande so marca a tabela como possivelmente incompleta em vez de
    // barrar). `acceptDrop: true` confirma que o usuario sabe que a origem encolheu/esvaziou e aceita substituir a tabela (auditado).
    const acceptDrop = body?.acceptDrop === true;
    if (acceptDrop) await audit(actor, "SOURCE_REFRESH_ACCEPT_DROP", "dataset_source", source.id, { fields: ["acceptDrop"], reconciliation });
    return ok(await queueSourceRefresh(source.id, { reconciliation, manual: true, acceptDrop }), undefined, 202);
  } catch (e) {
    return handleApiError(e);
  }
}
