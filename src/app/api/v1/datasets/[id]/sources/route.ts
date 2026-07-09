import type { NextRequest } from "next/server";
import { z } from "zod";
import { resolveActor } from "@/server/auth/actor";
import { canAccess } from "@/server/auth/permissions";
import { ApiError, handleApiError, ok } from "@/server/http";
import { createDatasetSource } from "@/server/connections/sources";

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
      sourceSql: z.string().optional().nullable(),
      refreshPolicy: z.enum(["manual", "hourly", "daily", "weekly"]).default("manual"),
    }).parse(await request.json());
    return ok(await createDatasetSource({ datasetId, ...input }), undefined, 201);
  } catch (e) {
    return handleApiError(e);
  }
}
