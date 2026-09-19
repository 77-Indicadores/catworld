/**
 * GET /api/v1/tables/:id/history — versoes (cargas que mudaram os dados) e execucoes recentes da tabela.
 * Somente leitura; mesma autorizacao da tabela (READ no dataset). `limit` 1-50 (padrao 20).
 */
import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { resolveActor } from "@/server/auth/actor";
import { assertDatasetAccess } from "@/server/auth/permissions";
import { ApiError, handleApiError, ok } from "@/server/http";
import { HISTORY_LIMIT, loadTableHistory } from "@/server/tables/history";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(request);
    const table = await prisma.datasetTable.findUnique({ where: { id: (await params).id }, select: { id: true, dataset: { select: { id: true, projectId: true } } } });
    if (!table) throw new ApiError(404, "NOT_FOUND", "Tabela não encontrada");
    await assertDatasetAccess(actor, "READ", table.dataset);

    let limit = HISTORY_LIMIT;
    const raw = request.nextUrl.searchParams.get("limit");
    if (raw !== null && raw.trim() !== "") {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) throw new ApiError(400, "VALIDATION_ERROR", "\"limit\" precisa ser um inteiro entre 1 e 50");
      limit = Math.min(n, 50);
    }
    return ok(await loadTableHistory(table.id, limit));
  } catch (e) {
    return handleApiError(e);
  }
}
