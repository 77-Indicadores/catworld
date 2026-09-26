import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { handleApiError, ok, publicQueryErrorMessage } from "@/server/http";
import { testPostgres } from "@/server/connections/postgres";
import { testMssql } from "@/server/connections/mssql";
import { testFirebird } from "@/server/connections/firebird";
import { firebirdEndpointFor } from "@/server/connections/sources";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(request);
    requireRole(actor, ["ADMIN"]);
    const connection = await prisma.connection.findUniqueOrThrow({ where: { id: (await params).id } });
    try {
      // firebird-ftp: testar de verdade exige materializar (download+gbak) — pode levar minutos aqui, diferente
      // de Postgres/MSSQL (abrir socket e autenticar, instantaneo). E uma acao explicita do admin, nao por tabela.
      const result = connection.provider === "mssql"
        ? await testMssql(connection)
        : connection.provider === "firebird-ftp"
          ? await testFirebird(await firebirdEndpointFor(connection))
          : await testPostgres(connection);
      await prisma.connection.update({ where: { id: connection.id }, data: { lastStatus: "healthy", lastLatencyMs: result.latencyMs, lastError: null, lastCheckedAt: new Date() } });
      return ok({ healthy: true, ...result });
    } catch (testError) {
      // Sem isto, uma falha de teste nao deixava rastro: a tela continuava mostrando o ultimo sucesso
      // (ou "Nao testada") como se nada tivesse mudado (ver auditoria de UX, achado "conexoes/sync").
      const message = testError instanceof Error ? publicQueryErrorMessage(testError.message) : "Falha ao testar a conexão.";
      await prisma.connection.update({ where: { id: connection.id }, data: { lastStatus: "error", lastError: message, lastCheckedAt: new Date() } });
      throw testError;
    }
  } catch (e) {
    return handleApiError(e);
  }
}
