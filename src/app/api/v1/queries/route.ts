import type { NextRequest } from "next/server";
import { z } from "zod";
import * as Sentry from "@sentry/nextjs";
import { resolveActor } from "@/server/auth/actor";
import { syncActorGrants } from "@/server/auth/sync-grants";
import { executeReadOnly } from "@/server/azure/sql";
import { ApiError, handleApiError, ok } from "@/server/http";
import { audit } from "@/server/audit";
import { prisma } from "@/server/db";

export async function POST(request: NextRequest) {
  try {
    const actor = await resolveActor(request);
    const input = z.object({
      sql: z.string().min(1).max(50000),
      timeout: z.number().int().min(1).max(120).default(30),
      limit: z.number().int().min(1).max(10000).default(10000),
      offset: z.number().int().min(0).default(0),
      datasetId: z.string().uuid().optional(),
      projectId: z.string().uuid().optional(),
    }).parse(await request.json());

    await syncActorGrants(actor);

    let schemas: string[] = [];
    if (input.datasetId) {
      const dataset = await prisma.dataset.findUnique({ where: { id: input.datasetId, active: true } });
      if (!dataset) throw new ApiError(404, "NOT_FOUND", "Dataset não encontrado");
      schemas = [dataset.schemaName];
    } else if (input.projectId) {
      const datasets = await prisma.dataset.findMany({ where: { projectId: input.projectId, active: true } });
      if (!datasets.length) throw new ApiError(404, "NOT_FOUND", "Nenhum dataset encontrado para este projeto");
      schemas = datasets.map((d) => d.schemaName);
    }

    const result = await executeReadOnly(actor.principal, input.sql, input.timeout, input.limit, schemas, input.offset);
    await audit(actor, "QUERY_EXECUTED", "query", undefined, { rowCount: result.rowCount, executionTimeMs: result.executionTimeMs });
    return ok(result);
  } catch (e) {
    if (e instanceof Error && "code" in e) {
      Sentry.captureException(e);
      return handleApiError(new ApiError(400, "QUERY_FAILED", e.message));
    }
    return handleApiError(e);
  }
}
