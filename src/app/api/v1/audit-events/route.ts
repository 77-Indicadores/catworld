import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { handleApiError, ok } from "@/server/http";

// Filtros opcionais (sem filtro = comportamento anterior: ultimos eventos, 100 por pagina).
const query = z.object({
  cursor: z.string().uuid().optional(),
  eventType: z.string().max(80).optional(),
  success: z.enum(["true", "false"]).optional(),
  userId: z.string().uuid().optional(),
  tokenId: z.string().uuid().optional(),
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
});

export async function GET(r: NextRequest) {
  try {
    const a = await resolveActor(r);
    requireRole(a, ["ADMIN", "DATA_MANAGER"]);
    const q = query.parse(Object.fromEntries(r.nextUrl.searchParams));
    const rows = await prisma.auditEvent.findMany({
      where: {
        ...(q.eventType ? { eventType: q.eventType } : {}),
        ...(q.success ? { success: q.success === "true" } : {}),
        ...(q.userId ? { userId: q.userId } : {}),
        ...(q.tokenId ? { tokenId: q.tokenId } : {}),
        ...(q.since || q.until ? { createdAt: { ...(q.since ? { gte: q.since } : {}), ...(q.until ? { lt: q.until } : {}) } } : {}),
      },
      take: 101,
      ...(q.cursor ? { skip: 1, cursor: { id: q.cursor } } : {}),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: { user: { select: { name: true, email: true } } },
    });
    const hasMore = rows.length > 100;
    const data = hasMore ? rows.slice(0, 100) : rows;
    return ok(data, { nextCursor: hasMore ? data.at(-1)?.id : null });
  } catch (e) {
    return handleApiError(e);
  }
}
