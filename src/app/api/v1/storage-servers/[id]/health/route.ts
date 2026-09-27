/**
 * GET /api/v1/storage-servers/:id/health — histórico de health-check (testes manuais) do storage server.
 * Storage servers não têm poll periódico nem DatasetSource associado, então não há duração média de fonte
 * aqui (diferente de /connections/:id/health) — só o log de cw_health_checks.
 */
import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { ApiError, handleApiError, ok } from "@/server/http";
import { loadStorageServerHealth } from "@/server/connections/health";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(request);
    requireRole(actor, ["ADMIN"]);
    const id = (await params).id;
    const storageServer = await prisma.storageServer.findUnique({ where: { id }, select: { id: true } });
    if (!storageServer) throw new ApiError(404, "NOT_FOUND", "Storage server não encontrado");
    return ok(await loadStorageServerHealth(id));
  } catch (e) {
    return handleApiError(e);
  }
}
