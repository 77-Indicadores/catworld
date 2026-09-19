import type { NextRequest } from "next/server";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { handleApiError, ok } from "@/server/http";
import { auditFilterSchema, queryAuditEvents } from "@/server/audit-query";

// Filtros opcionais (sem filtro = ultimos eventos, 100 por pagina). Mesma consulta da tela de Auditoria.
export async function GET(r: NextRequest) {
  try {
    const a = await resolveActor(r);
    requireRole(a, ["ADMIN", "DATA_MANAGER"]);
    const q = auditFilterSchema.parse(Object.fromEntries(r.nextUrl.searchParams));
    const { data, nextCursor } = await queryAuditEvents(q);
    return ok(data, { nextCursor });
  } catch (e) {
    return handleApiError(e);
  }
}
