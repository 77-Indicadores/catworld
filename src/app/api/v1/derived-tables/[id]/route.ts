import type { NextRequest } from "next/server";
import { validateReadOnlySql } from "@/server/security/sql-safety";
import { prisma } from "@/server/db";
import { nextRefreshFromCron } from "@/server/connections/sources";
import { resolveActor } from "@/server/auth/actor";
import { assertDatasetAccess } from "@/server/auth/permissions";
import { ApiError, handleApiError, ok } from "@/server/http";
import { assertSqlSchemasAllowed } from "@/server/sql-contract/references";

/** Carrega a derivada + dataset (para checar acesso). 404 se nao existir. */
async function loadDerived(id: string) {
  const dt = await prisma.derivedTable.findUnique({
    where: { id },
    include: {
      targetTable: { select: { id: true, rowCount: true, lastDataAt: true } },
      dataset: { select: { id: true, projectId: true } },
    },
  });
  if (!dt) throw new ApiError(404, "NOT_FOUND", "Não encontrado");
  return dt;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req);
    const { dataset, ...dt } = await loadDerived((await params).id);
    await assertDatasetAccess(actor, "READ", dataset);
    return ok(dt);
  } catch (e) {
    return handleApiError(e);
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req);
    const { id } = await params;
    const { dataset, ...dt } = await loadDerived(id);
    await assertDatasetAccess(actor, "WRITE", dataset);

    const body = await req.json() as {
      name?: string;
      querySql?: string;
      refreshCron?: string | null;
      active?: boolean;
    };

    if (body.querySql) {
      const safety = validateReadOnlySql(body.querySql);
      if (!safety.safe) throw new ApiError(400, "UNSAFE_SQL", safety.reason);
      const owner = await prisma.dataset.findUnique({ where: { id: dataset.id }, select: { schemaName: true } });
      await assertSqlSchemasAllowed(actor, body.querySql, owner?.schemaName ?? "");
    }

    const refreshCron = "refreshCron" in body ? body.refreshCron : dt.refreshCron;
    const nextRefreshAt = nextRefreshFromCron(refreshCron);

    const updated = await prisma.derivedTable.update({
      where: { id },
      data: {
        ...(body.name ? { name: body.name.trim() } : {}),
        ...(body.querySql ? { querySql: body.querySql.trim() } : {}),
        ...("refreshCron" in body ? { refreshCron, nextRefreshAt } : {}),
        ...("active" in body ? { active: body.active } : {}),
      },
    });

    return ok(updated);
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req);
    const { id } = await params;
    const { dataset } = await loadDerived(id);
    await assertDatasetAccess(actor, "WRITE", dataset);
    await prisma.derivedTable.delete({ where: { id } });
    return ok({ deleted: true });
  } catch (e) {
    return handleApiError(e);
  }
}
