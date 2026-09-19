import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { handleApiError, ok } from "@/server/http";

// Acao GLOBAL: so ADMIN e DATA_MANAGER.
export async function POST(request: NextRequest) {
  try {
    requireRole(await resolveActor(request), ["ADMIN", "DATA_MANAGER"]);
    const result = await prisma.job.updateMany({
      where: { status: "FAILED" },
      data: { status: "COMPLETED", lastError: null },
    });
    return ok({ dismissed: result.count });
  } catch (e) {
    return handleApiError(e);
  }
}
