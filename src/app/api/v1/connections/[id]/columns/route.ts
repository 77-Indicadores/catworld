import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { handleApiError, ok } from "@/server/http";
import { ctxQueryColumns, ctxTableColumns, firebirdEndpointFor, providerCtxFor } from "@/server/connections/sources";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(request);
    requireRole(actor, ["ADMIN"]);
    const connection = await prisma.connection.findUniqueOrThrow({ where: { id: (await params).id } });
    const schema = request.nextUrl.searchParams.get("schema");
    const table = request.nextUrl.searchParams.get("table");
    const sqlParam = request.nextUrl.searchParams.get("sql");
    // Probar colunas de firebird-ftp exige materializar (ou reusar, se dentro do TTL) — pode levar minutos na 1a chamada.
    const firebirdEndpoint = connection.provider === "firebird-ftp" ? await firebirdEndpointFor(connection) : undefined;
    const ctx = providerCtxFor(connection, firebirdEndpoint);
    return ok(sqlParam ? await ctxQueryColumns(ctx, sqlParam) : await ctxTableColumns(ctx, schema ?? "", table ?? ""));
  } catch (e) {
    return handleApiError(e);
  }
}
