import { z } from "zod";
import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { resolveActor } from "@/server/auth/actor";
import { canAccess } from "@/server/auth/permissions";
import { ApiError, handleApiError, ok } from "@/server/http";
import { nextRefresh } from "@/server/connections/sources";
import { deleteDatasetSource } from "@/server/data/catalog";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(request);
    const id = (await params).id;
    const source = await prisma.datasetSource.findUniqueOrThrow({
      where: { id },
      include: { connection: { select: { id: true, name: true, provider: true } }, dataset: { select: { projectId: true } } },
    });
    if (actor.role !== "ADMIN" && !await canAccess(actor, "READ", source.dataset.projectId, source.datasetId)) {
      throw new ApiError(403, "FORBIDDEN", "Sem permissão para ler esta fonte");
    }
    return ok(source);
  } catch (e) {
    return handleApiError(e);
  }
}

const patchSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  mode: z.enum(["extract", "live"]).optional(),
  refreshPolicy: z.enum(["manual", "hourly", "daily", "weekly"]).optional(),
  keyColumn: z.string().max(128).nullable().optional(),
  deltaColumn: z.string().max(128).nullable().optional(),
  sourceSql: z.string().min(1).nullable().optional(),
  active: z.boolean().optional(),
});

async function authorise(request: NextRequest, id: string) {
  const actor = await resolveActor(request);
  const source = await prisma.datasetSource.findUniqueOrThrow({
    where: { id },
    select: { datasetId: true, dataset: { select: { projectId: true } } },
  });
  if (actor.role !== "ADMIN" && !await canAccess(actor, "WRITE", source.dataset.projectId, source.datasetId)) {
    throw new ApiError(403, "FORBIDDEN", "Sem permissão para modificar esta fonte");
  }
  return { actor, source };
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = (await params).id;
    await authorise(request, id);
    const input = patchSchema.parse(await request.json());

    const effectivePolicy = input.mode === "live" ? "manual" : (input.refreshPolicy ?? undefined);
    const nextAt = effectivePolicy && effectivePolicy !== "manual" ? nextRefresh(effectivePolicy) : (effectivePolicy === "manual" ? null : undefined);

    return ok(await prisma.datasetSource.update({
      where: { id },
      data: {
        ...input,
        ...(input.mode === "live" ? { refreshPolicy: "manual", nextRefreshAt: null } : {}),
        ...(effectivePolicy !== undefined && input.mode !== "live" && nextAt !== undefined ? { nextRefreshAt: nextAt } : {}),
      },
    }));
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = (await params).id;
    await authorise(request, id);
    await deleteDatasetSource(id);
    return ok({ deleted: true });
  } catch (e) {
    return handleApiError(e);
  }
}
