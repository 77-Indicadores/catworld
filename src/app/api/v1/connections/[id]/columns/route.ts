import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { handleApiError, ok } from "@/server/http";
import { queryColumns, tableColumns } from "@/server/connections/postgres";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(request);
    requireRole(actor, ["ADMIN"]);
    const connection = await prisma.connection.findUniqueOrThrow({ where: { id: (await params).id } });
    const schema = request.nextUrl.searchParams.get("schema");
    const table = request.nextUrl.searchParams.get("table");
    const sql = request.nextUrl.searchParams.get("sql");
    return ok(sql ? await queryColumns(connection, sql) : await tableColumns(connection, schema ?? "", table ?? ""));
  } catch (e) {
    return handleApiError(e);
  }
}
