import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { handleApiError, ok, ApiError } from "@/server/http";
import { encryptSecret } from "@/server/security/crypto";

function maskUrl(url: string): string {
  return url.replace(/password=[^;]+/gi, "password=••••••••");
}

const visible = {
  id: true,
  name: true,
  url: true,
  isDefault: true,
  active: true,
  lastStatus: true,
  lastLatencyMs: true,
  lastCheckedAt: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { datasets: true } },
} as const;

const patchSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  url: z.string().min(10).optional(),
  isDefault: z.boolean().optional(),
  active: z.boolean().optional(),
});

export async function GET(r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(r);
    requireRole(actor, ["ADMIN"]);
    const id = (await params).id;
    const server = await prisma.storageServer.findUnique({ where: { id }, select: visible });
    if (!server) throw new ApiError(404, "NOT_FOUND", "StorageServer não encontrado");
    return ok(server);
  } catch (e) {
    return handleApiError(e);
  }
}

export async function PATCH(r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(r);
    requireRole(actor, ["ADMIN"]);
    const id = (await params).id;
    const input = patchSchema.parse(await r.json());

    if (input.isDefault) {
      await prisma.storageServer.updateMany({ where: { id: { not: id } }, data: { isDefault: false } });
    }

    const server = await prisma.storageServer.update({
      where: { id },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.url !== undefined && {
          url: maskUrl(input.url),
          encryptedCredentials: encryptSecret(input.url),
        }),
        ...(input.isDefault !== undefined && { isDefault: input.isDefault }),
        ...(input.active !== undefined && { active: input.active }),
      },
      select: visible,
    });

    return ok(server);
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(r);
    requireRole(actor, ["ADMIN"]);
    const id = (await params).id;

    const server = await prisma.storageServer.findUnique({
      where: { id },
      select: { isDefault: true, _count: { select: { datasets: true } } },
    });
    if (!server) throw new ApiError(404, "NOT_FOUND", "StorageServer não encontrado");
    if (server.isDefault) throw new ApiError(400, "IS_DEFAULT", "Não é possível remover o StorageServer padrão");
    if (server._count.datasets > 0) {
      throw new ApiError(400, "HAS_DATASETS", `${server._count.datasets} dataset(s) estão usando este servidor`);
    }

    await prisma.storageServer.delete({ where: { id } });
    return ok({ deleted: true });
  } catch (e) {
    return handleApiError(e);
  }
}
