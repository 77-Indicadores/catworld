import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { handleApiError, ok } from "@/server/http";
import { testPostgres } from "@/server/connections/postgres";
import { testMssql } from "@/server/connections/mssql";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(request);
    requireRole(actor, ["ADMIN"]);
    const connection = await prisma.connection.findUniqueOrThrow({ where: { id: (await params).id } });
    const result = connection.provider === "mssql" ? await testMssql(connection) : await testPostgres(connection);
    await prisma.connection.update({ where: { id: connection.id }, data: { lastStatus: "healthy", lastLatencyMs: result.latencyMs, lastCheckedAt: new Date() } });
    return ok({ healthy: true, ...result });
  } catch (e) {
    return handleApiError(e);
  }
}
