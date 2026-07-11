import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { handleApiError, ok } from "@/server/http";
import { listTables } from "@/server/connections/postgres";
import { listTablesMssql } from "@/server/connections/mssql";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(request);
    requireRole(actor, ["ADMIN"]);
    const connection = await prisma.connection.findUniqueOrThrow({ where: { id: (await params).id } });
    const schema = request.nextUrl.searchParams.get("schema") ?? undefined;
    return ok(connection.provider === "mssql" ? await listTablesMssql(connection, schema) : await listTables(connection, schema));
  } catch (e) {
    return handleApiError(e);
  }
}
