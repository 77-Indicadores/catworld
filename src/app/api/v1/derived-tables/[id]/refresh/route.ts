import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { queueDerivedRefresh } from "@/server/connections/derived";
import { resolveActor } from "@/server/auth/actor";
import { assertDatasetAccess } from "@/server/auth/permissions";
import { ApiError, handleApiError, ok } from "@/server/http";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req);
    const { id } = await params;
    const dt = await prisma.derivedTable.findUnique({
      where: { id },
      include: { dataset: { select: { id: true, projectId: true } } },
    });
    if (!dt) throw new ApiError(404, "NOT_FOUND", "Não encontrado");
    await assertDatasetAccess(actor, "WRITE", dt.dataset);
    if (!dt.active) throw new ApiError(409, "DERIVED_INACTIVE", "Tabela derivada inativa");
    const job = await queueDerivedRefresh(id);
    return ok({ jobId: job.id });
  } catch (e) {
    return handleApiError(e);
  }
}
