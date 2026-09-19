/** GET/DELETE /api/v1/system/commands/:id — consulta o andamento; DELETE cancela um comando ainda PENDING. ADMIN. */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { audit } from "@/server/audit";
import { ApiError, handleApiError, ok } from "@/server/http";

const idSchema = z.string().uuid();

export async function GET(r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(r);
    requireRole(actor, ["ADMIN"]);
    const cmd = await prisma.systemCommand.findUnique({ where: { id: idSchema.parse((await params).id) }, include: { profile: { select: { name: true } } } });
    if (!cmd) throw new ApiError(404, "NOT_FOUND", "Comando não encontrado");
    return ok(cmd);
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(r);
    requireRole(actor, ["ADMIN"]);
    const id = idSchema.parse((await params).id);
    // Só cancela enquanto ninguém aceitou: depois disso o supervisor já começou a agir.
    const res = await prisma.systemCommand.updateMany({ where: { id, status: "PENDING" }, data: { status: "CANCELLED", finishedAt: new Date() } });
    if (res.count === 0) {
      const exists = await prisma.systemCommand.findUnique({ where: { id }, select: { id: true } });
      if (!exists) throw new ApiError(404, "NOT_FOUND", "Comando não encontrado");
      throw new ApiError(409, "COMMAND_NOT_CANCELLABLE", "O comando já foi aceito pelo supervisor e não pode mais ser cancelado.");
    }
    await audit(actor, "WORKER_COMMAND_CANCELLED", "system_command", id, {});
    return ok({ cancelled: true });
  } catch (e) {
    return handleApiError(e);
  }
}
