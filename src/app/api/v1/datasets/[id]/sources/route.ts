import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/server/db";
import { resolveActor } from "@/server/auth/actor";
import { canAccess } from "@/server/auth/permissions";
import { ApiError, handleApiError, ok } from "@/server/http";
import { createDatasetSource, createDatasetSources } from "@/server/connections/sources";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(request);
    const datasetId = (await params).id;
    if (!await canAccess(actor, "READ", undefined, datasetId) && actor.role !== "ADMIN") throw new ApiError(403, "FORBIDDEN", "Sem permissao para ler o dataset");
    return ok(await prisma.datasetSource.findMany({
      where: { datasetId, active: true },
      include: { connection: { select: { id: true, name: true, provider: true } }, targetTable: { include: { columns: { orderBy: { ordinal: "asc" } } } } },
      orderBy: { name: "asc" },
    }));
  } catch (e) {
    return handleApiError(e);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(request);
    const datasetId = (await params).id;
    if (!await canAccess(actor, "WRITE", undefined, datasetId) && actor.role !== "ADMIN") throw new ApiError(403, "FORBIDDEN", "Sem permissao para editar o dataset");
    const input = z.object({
      connectionId: z.string().uuid(),
      name: z.string().min(1).max(255).optional(),
      mode: z.enum(["extract", "live"]),
      sourceKind: z.enum(["table", "query"]),
      sourceSchema: z.string().optional().nullable(),
      sourceTable: z.string().optional().nullable(),
      sourceTables: z.array(z.string().min(1)).optional(),
      sourceSql: z.string().optional().nullable(),
      refreshPolicy: z.enum(["manual", "hourly", "daily", "weekly"]).default("manual"),
      sourceGroupId: z.string().uuid().optional(),
    }).parse(await request.json());
    if (input.sourceKind === "table" && input.sourceTables?.length) {
      return ok(await createDatasetSources({
        datasetId,
        connectionId: input.connectionId,
        mode: input.mode,
        sourceSchema: input.sourceSchema ?? "",
        sourceTables: input.sourceTables,
        refreshPolicy: input.refreshPolicy,
        sourceGroupId: input.sourceGroupId,
      }), undefined, 201);
    }
    return ok(await createDatasetSource({ datasetId, ...input }), undefined, 201);
  } catch (e) {
    return handleApiError(e);
  }
}
