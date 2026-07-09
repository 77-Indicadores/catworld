import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/server/db";
import { resolveActor } from "@/server/auth/actor";
import { canAccess } from "@/server/auth/permissions";
import { ApiError, handleApiError, ok } from "@/server/http";
import { executePostgresReadOnly, quotedPgTable } from "@/server/connections/postgres";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(request);
    const input = z.object({ sql: z.string().min(1).max(50000).optional(), timeout: z.number().int().min(1).max(120).default(30), limit: z.number().int().min(1).max(10000).default(10000) }).parse(await request.json());
    const source = await prisma.datasetSource.findUniqueOrThrow({ where: { id: (await params).id }, include: { dataset: true, connection: true } });
    if (!await canAccess(actor, "READ", source.dataset.projectId, source.datasetId) && actor.role !== "ADMIN") throw new ApiError(403, "FORBIDDEN", "Sem permissao para ler a fonte");
    if (source.mode !== "live") throw new ApiError(400, "NOT_LIVE", "Fonte nao e live");
    const sql = input.sql
      ? qualifySourceTable(input.sql, source)
      : source.sourceKind === "table" ? `SELECT * FROM ${quotedPgTable(source.sourceSchema!, source.sourceTable!)}` : source.sourceSql!;
    return ok(await executePostgresReadOnly(source.connection, sql, input.timeout, input.limit));
  } catch (e) {
    if (e instanceof Error && "code" in e) return handleApiError(new ApiError(400, "POSTGRES_QUERY_FAILED", e.message));
    return handleApiError(e);
  }
}

function qualifySourceTable(sql: string, source: { sourceKind: string; sourceSchema: string | null; sourceTable: string | null }) {
  if (source.sourceKind !== "table" || !source.sourceSchema || !source.sourceTable) return sql;
  const quoted = quotedPgTable(source.sourceSchema, source.sourceTable);
  const table = source.sourceTable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return sql.replace(new RegExp(`\\b(FROM|JOIN)\\s+("${table}"|${table})\\b`, "gi"), `$1 ${quoted}`);
}
