/**
 * GET /api/v1/connections/:id/health — histórico de health-check (polls/testes) e duração média
 * de sync por fonte desta conexão. Somente ADMIN, mesma autorização das outras rotas de conexão.
 */
import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { ApiError, handleApiError, ok } from "@/server/http";
import { loadConnectionHealth } from "@/server/connections/health";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(request);
    requireRole(actor, ["ADMIN"]);
    const id = (await params).id;
    const connection = await prisma.connection.findUnique({ where: { id }, select: { id: true } });
    if (!connection) throw new ApiError(404, "NOT_FOUND", "Conexão não encontrada");
    return ok(await loadConnectionHealth(id));
  } catch (e) {
    return handleApiError(e);
  }
}
