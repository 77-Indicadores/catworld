/** GET/PATCH/DELETE /api/v1/worker-profiles/:id. ADMIN. */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { audit } from "@/server/audit";
import { ApiError, handleApiError, ok } from "@/server/http";
import { needsRestart, profilePatchSchema, uncoveredJobTypes } from "@/server/worker/profiles";
import { getSupervisorStatus } from "@/server/worker/status";

const idSchema = z.string().uuid();

async function load(id: string) {
  const p = await prisma.workerProfile.findUnique({ where: { id: idSchema.parse(id) } });
  if (!p) throw new ApiError(404, "PROFILE_NOT_FOUND", "Perfil de worker não encontrado");
  return p;
}

export async function GET(r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(r);
    requireRole(actor, ["ADMIN"]);
    return ok(await load((await params).id));
  } catch (e) {
    return handleApiError(e);
  }
}

export async function PATCH(r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(r);
    requireRole(actor, ["ADMIN"]);
    const before = await load((await params).id);
    const patch = profilePatchSchema.parse(await r.json());
    if (Object.keys(patch).length === 0) throw new ApiError(400, "VALIDATION_ERROR", "Nada para alterar");
    const updated = await prisma.workerProfile.update({ where: { id: before.id }, data: { ...patch, revision: { increment: 1 } } });
    await audit(actor, "WORKER_PROFILE_UPDATED", "worker_profile", updated.id, { name: updated.name, fields: Object.keys(patch) });
    const restartRequired = needsRestart(before, updated);
    const warnings: string[] = [];
    const uncovered = uncoveredJobTypes(await prisma.workerProfile.findMany());
    if (uncovered.length) warnings.push(`Nenhum perfil habilitado processa: ${uncovered.join(", ")}.`);
    return ok(updated, { restartRequired, ...(warnings.length ? { warnings } : {}) });
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(r);
    requireRole(actor, ["ADMIN"]);
    const p = await load((await params).id);
    // Apagar com o processo rodando o deixaria sem perfil: desabilite (drena) e só então remova.
    const running = (await getSupervisorStatus()).children.find((c) => c.name === p.name && c.pid !== null);
    if (running) throw new ApiError(409, "PROFILE_RUNNING", "O worker deste perfil está em execução. Desabilite o perfil, espere ele parar e então remova.");
    await prisma.workerProfile.delete({ where: { id: p.id } });
    await audit(actor, "WORKER_PROFILE_DELETED", "worker_profile", p.id, { name: p.name });
    const uncovered = uncoveredJobTypes(await prisma.workerProfile.findMany());
    return ok({ deleted: true }, uncovered.length ? { warnings: [`Nenhum perfil habilitado processa: ${uncovered.join(", ")}.`] } : undefined);
  } catch (e) {
    return handleApiError(e);
  }
}
