import type { NextRequest } from "next/server";
import { validateReadOnlySql } from "@/server/security/sql-safety";
import { prisma } from "@/server/db";
import { sqlIdentifier } from "@/server/security/naming";
import { nextRefreshFromCron } from "@/server/connections/sources";
import { queueDerivedRefresh } from "@/server/connections/derived";
import { resolveActor } from "@/server/auth/actor";
import { assertDatasetAccess } from "@/server/auth/permissions";
import { ApiError, handleApiError, ok } from "@/server/http";

async function loadDataset(datasetId: string) {
  const dataset = await prisma.dataset.findUnique({ where: { id: datasetId }, select: { id: true, projectId: true } });
  if (!dataset) throw new ApiError(404, "DATASET_NOT_FOUND", "Dataset não encontrado");
  return dataset;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req);
    const { id: datasetId } = await params;
    await assertDatasetAccess(actor, "READ", await loadDataset(datasetId));
    const items = await prisma.derivedTable.findMany({
      where: { datasetId, active: true },
      orderBy: { createdAt: "asc" },
      include: { targetTable: { select: { id: true, rowCount: true, lastDataAt: true } } },
    });
    return ok(items);
  } catch (e) {
    return handleApiError(e);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req);
    const { id: datasetId } = await params;
    const dataset = await loadDataset(datasetId);
    await assertDatasetAccess(actor, "WRITE", dataset);

    const body = await req.json() as {
      name?: string;
      sqlName?: string;
      querySql?: string;
      refreshCron?: string | null;
      triggerNow?: boolean;
    };

    if (!body.querySql?.trim()) throw new ApiError(400, "BAD_REQUEST", "querySql obrigatório");
    if (!body.name?.trim()) throw new ApiError(400, "BAD_REQUEST", "name obrigatório");

    const safety = validateReadOnlySql(body.querySql);
    if (!safety.safe) throw new ApiError(400, "UNSAFE_SQL", safety.reason);

    const sqlName = body.sqlName?.trim()
      ? sqlIdentifier(body.sqlName.trim())
      : sqlIdentifier(body.name.trim());

    const existing = await prisma.datasetTable.findFirst({ where: { datasetId, sqlName } });
    if (existing) {
      const alreadyDerived = await prisma.derivedTable.findFirst({ where: { datasetId, sqlName } });
      if (alreadyDerived) throw new ApiError(409, "DERIVED_EXISTS", "Tabela derivada já existe");
    }

    const dt = await prisma.derivedTable.create({
      data: {
        datasetId,
        targetTableId: existing?.id ?? null,
        name: body.name.trim(),
        sqlName,
        querySql: body.querySql.trim(),
        refreshCron: body.refreshCron ?? null,
        nextRefreshAt: nextRefreshFromCron(body.refreshCron),
      },
    });

    if (body.triggerNow) {
      await queueDerivedRefresh(dt.id).catch((e) =>
        console.warn("[derived] queueDerivedRefresh failed: %s", e instanceof Error ? e.message : e),
      );
    }

    return ok(dt, undefined, 201);
  } catch (e) {
    return handleApiError(e);
  }
}
