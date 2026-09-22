import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { handleApiError, ok } from "@/server/http";
import { queryColumns, tableColumns } from "@/server/connections/postgres";
import { queryColumnsMssql, tableColumnsMssql } from "@/server/connections/mssql";
import { queryColumnsFirebird, tableColumnsFirebird } from "@/server/connections/firebird";
import { firebirdEndpointFor } from "@/server/connections/sources";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(request);
    requireRole(actor, ["ADMIN"]);
    const connection = await prisma.connection.findUniqueOrThrow({ where: { id: (await params).id } });
    const schema = request.nextUrl.searchParams.get("schema");
    const table = request.nextUrl.searchParams.get("table");
    const sqlParam = request.nextUrl.searchParams.get("sql");
    if (connection.provider === "mssql") {
      return ok(sqlParam ? await queryColumnsMssql(connection, sqlParam) : await tableColumnsMssql(connection, schema ?? "", table ?? ""));
    }
    if (connection.provider === "firebird-ftp") {
      // Probar colunas exige materializar (ou reusar, se dentro do TTL) — pode levar minutos na 1a chamada.
      const endpoint = await firebirdEndpointFor(connection);
      return ok(sqlParam ? await queryColumnsFirebird(endpoint, sqlParam) : await tableColumnsFirebird(endpoint, schema ?? "", table ?? ""));
    }
    return ok(sqlParam ? await queryColumns(connection, sqlParam) : await tableColumns(connection, schema ?? "", table ?? ""));
  } catch (e) {
    return handleApiError(e);
  }
}
