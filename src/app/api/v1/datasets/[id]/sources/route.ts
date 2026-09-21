import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/server/db";
import { resolveActor } from "@/server/auth/actor";
import { assertCanUseConnection, assertDatasetAccess } from "@/server/auth/permissions";
import { ApiError, handleApiError, ok } from "@/server/http";
import { assertDeleteDetection, assertValidCron, createDatasetSource, createDatasetSources, exposeSource } from "@/server/connections/sources";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(request);
    const datasetId = (await params).id;
    // canAccess(..., undefined, datasetId) ignorava grants de PROJETO; assertDatasetAccess usa o projectId do dataset.
    const ds = await prisma.dataset.findUnique({ where: { id: datasetId }, select: { id: true, projectId: true } });
    if (!ds) throw new ApiError(404, "DATASET_NOT_FOUND", "Dataset não encontrado");
    await assertDatasetAccess(actor, "READ", ds);
    return ok((await prisma.datasetSource.findMany({
      where: { datasetId, active: true },
      include: { connection: { select: { id: true, name: true, provider: true } }, targetTable: { include: { columns: { orderBy: { ordinal: "asc" } } } } },
      orderBy: { name: "asc" },
    })).map(exposeSource));
  } catch (e) {
    return handleApiError(e);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(request);
    const datasetId = (await params).id;
    const ds = await prisma.dataset.findUnique({ where: { id: datasetId }, select: { id: true, projectId: true } });
    if (!ds) throw new ApiError(404, "DATASET_NOT_FOUND", "Dataset não encontrado");
    await assertDatasetAccess(actor, "WRITE", ds);
    const input = z.object({
      connectionId: z.string().uuid(),
      name: z.string().min(1).max(255).optional(),
      mode: z.enum(["extract", "live"]),
      sourceKind: z.enum(["table", "query"]),
      sourceSchema: z.string().optional().nullable(),
      sourceTable: z.string().optional().nullable(),
      sourceTables: z.array(z.string().min(1)).optional(),
      sourceSql: z.string().optional().nullable(),
      refreshCron: z.string().max(100).nullable().optional(),
      keyColumn: z.string().max(128).nullable().optional(),
      deltaColumn: z.string().max(128).nullable().optional(),
      reconciliationCron: z.string().max(100).nullable().optional(),
      sourceSqlReconciliation: z.string().nullable().optional(),
      detectDeletions: z.boolean().optional(),
      keysSql: z.string().nullable().optional(),
      keysMinIntervalMinutes: z.number().int().min(1).nullable().optional(),
      sourceGroupId: z.string().uuid().optional(),
      onInvalid: z.enum(["null", "fail"]).optional(),
    }).parse(await request.json());
    await assertCanUseConnection(actor, input.connectionId, ds);
    assertValidCron(input.refreshCron, "refreshCron");
    assertValidCron(input.reconciliationCron, "reconciliationCron");
    assertDeleteDetection({
      mode: input.mode, sourceKind: input.sourceKind, keyColumn: input.keyColumn,
      detectDeletions: input.detectDeletions, keysSql: input.keysSql?.trim() || null, keysMinIntervalMinutes: input.keysMinIntervalMinutes,
    });
    if (input.sourceKind === "table" && input.sourceTables?.length) {
      return ok((await createDatasetSources({
        datasetId,
        connectionId: input.connectionId,
        mode: input.mode,
        sourceSchema: input.sourceSchema ?? "",
        sourceTables: input.sourceTables,
        refreshCron: input.refreshCron,
        keyColumn: input.keyColumn,
        deltaColumn: input.deltaColumn,
        reconciliationCron: input.reconciliationCron,
        detectDeletions: input.detectDeletions,
        keysMinIntervalMinutes: input.keysMinIntervalMinutes,
        sourceGroupId: input.sourceGroupId,
      })).map(exposeSource), undefined, 201);
    }
    if (input.sourceKind === "query" && !input.name?.trim()) {
      throw new ApiError(400, "INVALID_SOURCE", "Fonte por consulta exige um nome");
    }
    return ok(exposeSource(await createDatasetSource({ datasetId, ...input })), undefined, 201);
  } catch (e) {
    return handleApiError(e);
  }
}
