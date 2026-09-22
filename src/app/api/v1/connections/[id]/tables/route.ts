import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { handleApiError, ok } from "@/server/http";
import { listTables } from "@/server/connections/postgres";
import { listTablesMssql } from "@/server/connections/mssql";
import { listTablesFirebird } from "@/server/connections/firebird";
import { firebirdEndpointFor } from "@/server/connections/sources";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(request);
    requireRole(actor, ["ADMIN"]);
    const connection = await prisma.connection.findUniqueOrThrow({ where: { id: (await params).id } });
    const schema = request.nextUrl.searchParams.get("schema") ?? undefined;
    if (connection.provider === "firebird-ftp") {
      // Listar tabelas exige materializar (ou reusar, se dentro do TTL) — pode levar minutos na 1a chamada.
      return ok(await listTablesFirebird(await firebirdEndpointFor(connection)));
    }
    return ok(connection.provider === "mssql" ? await listTablesMssql(connection, schema) : await listTables(connection, schema));
  } catch (e) {
    return handleApiError(e);
  }
}
