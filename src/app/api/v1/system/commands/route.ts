/**
 * GET/POST /api/v1/system/commands — reiniciar/parar/iniciar workers pela tela (ADMIN).
 * O comando fica no banco; o supervisor o executa (ver docs/worker-architecture.md). Nunca enfileira no vazio:
 * sem supervisor vivo responde 409 SUPERVISOR_NOT_RUNNING.
 */
import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { audit } from "@/server/audit";
import { ApiError, handleApiError, ok } from "@/server/http";
import { commandCreateSchema, commandsConflict, isOpen, needsProfile, type CommandAction, type CommandStatus } from "@/server/worker/commands";
import { getSupervisorStatus } from "@/server/worker/status";
import { actorLabel } from "@/server/auth/actor-label";

export async function GET(r: NextRequest) {
  try {
    const actor = await resolveActor(r);
    requireRole(actor, ["ADMIN"]);
    return ok(await prisma.systemCommand.findMany({ orderBy: { requestedAt: "desc" }, take: 50, include: { profile: { select: { name: true } } } }));
  } catch (e) {
    return handleApiError(e);
  }
}

export async function POST(r: NextRequest) {
  try {
    const actor = await resolveActor(r);
    requireRole(actor, ["ADMIN"]);
    const input = commandCreateSchema.parse(await r.json());

    let profileName: string | null = null;
    if (needsProfile(input.action)) {
      const profile = await prisma.workerProfile.findUnique({ where: { id: input.profileId! } });
      if (!profile) throw new ApiError(404, "PROFILE_NOT_FOUND", "Perfil de worker não encontrado");
      profileName = profile.name;
    }

    if (!(await getSupervisorStatus()).supervised) {
      throw new ApiError(409, "SUPERVISOR_NOT_RUNNING", "Nenhum supervisor está ativo, então o comando não seria executado. Suba o serviço de workers (npm run supervisor).");
    }

    const open = (await prisma.systemCommand.findMany({ where: { status: { in: ["PENDING", "ACCEPTED", "DRAINING", "APPLYING"] } } }))
      .filter((c) => isOpen(c.status as CommandStatus));
    const clash = open.find((c) => commandsConflict({ action: c.action as CommandAction, profileId: c.profileId }, { action: input.action, profileId: input.profileId ?? null }));
    if (clash) throw new ApiError(409, "COMMAND_IN_PROGRESS", "Já existe um comando em andamento para este worker. Espere terminar ou cancele o pendente.");

    const requestedBy = await actorLabel(actor);
    const created = await prisma.systemCommand.create({
      data: {
        action: input.action,
        mode: input.mode,
        profileId: input.profileId ?? null,
        timeoutMs: input.timeoutMs,
        requestedBy,
        requestedById: actor.type === "user" ? actor.id : null,
      },
    });
    await audit(actor, input.action.startsWith("RESTART") ? "WORKER_RESTART_REQUESTED" : "WORKER_COMMAND_REQUESTED", "system_command", created.id, {
      action: input.action, mode: input.mode, profile: profileName, timeoutMs: input.timeoutMs,
    });
    return ok(created, undefined, 201);
  } catch (e) {
    return handleApiError(e);
  }
}
