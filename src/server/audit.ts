import { prisma } from "@/server/db";
import type { Actor } from "@/server/auth/actor";
import { getAuditIp } from "@/server/audit-request";

/**
 * Evento de auditoria de dominio. Nunca lanca (falha e logada) e o `detail` nunca deve carregar valores de corpo:
 * passe `{ method, fields }` (nomes de campos), como no contrato de auditoria.
 */
export async function audit(actor: Actor | null, eventType: string, resourceType?: string, resourceId?: string, detail?: unknown, success = true): Promise<void> {
  try {
    await prisma.auditEvent.create({
      data: {
        userId: actor?.type === "user" ? actor.id : null,
        tokenId: actor?.type === "token" ? actor.id : null,
        eventType, resourceType, resourceId,
        detailJson: detail ? JSON.stringify(detail) : null,
        ipAddress: getAuditIp(),
        success,
      },
    });
  } catch (e) {
    console.warn("[audit] falha ao gravar evento: %s", e instanceof Error ? e.message : e);
  }
}
