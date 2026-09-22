import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { handleApiError, ok } from "@/server/http";
import { testPostgres } from "@/server/connections/postgres";
import { testMssql } from "@/server/connections/mssql";
import { testFirebird } from "@/server/connections/firebird";
import { firebirdEndpointFor } from "@/server/connections/sources";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(request);
    requireRole(actor, ["ADMIN"]);
    const connection = await prisma.connection.findUniqueOrThrow({ where: { id: (await params).id } });
    // firebird-ftp: testar de verdade exige materializar (download+gbak) — pode levar minutos aqui, diferente
    // de Postgres/MSSQL (abrir socket e autenticar, instantaneo). E uma acao explicita do admin, nao por tabela.
    const result = connection.provider === "mssql"
      ? await testMssql(connection)
      : connection.provider === "firebird-ftp"
        ? await testFirebird(await firebirdEndpointFor(connection))
        : await testPostgres(connection);
    await prisma.connection.update({ where: { id: connection.id }, data: { lastStatus: "healthy", lastLatencyMs: result.latencyMs, lastCheckedAt: new Date() } });
    return ok({ healthy: true, ...result });
  } catch (e) {
    return handleApiError(e);
  }
}
