/** GET/POST /api/v1/worker-profiles — perfis de worker (config por processo, guardada no banco). ADMIN. */
import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { audit } from "@/server/audit";
import { handleApiError, ok } from "@/server/http";
import { profileCreateSchema, uncoveredJobTypes } from "@/server/worker/profiles";

export async function GET(r: NextRequest) {
  try {
    const actor = await resolveActor(r);
    requireRole(actor, ["ADMIN"]);
    return ok(await prisma.workerProfile.findMany({ orderBy: { name: "asc" } }));
  } catch (e) {
    return handleApiError(e);
  }
}

export async function POST(r: NextRequest) {
  try {
    const actor = await resolveActor(r);
    requireRole(actor, ["ADMIN"]);
    const input = profileCreateSchema.parse(await r.json());
    // nome duplicado vira 409 CONFLICT pelo handleApiError (P2002)
    const created = await prisma.workerProfile.create({ data: input });
    await audit(actor, "WORKER_PROFILE_CREATED", "worker_profile", created.id, { name: created.name, jobTypes: created.jobTypes, concurrency: created.concurrency });
    const all = await prisma.workerProfile.findMany();
    const uncovered = uncoveredJobTypes(all);
    return ok(created, uncovered.length ? { warnings: [`Nenhum perfil habilitado processa: ${uncovered.join(", ")}.`] } : undefined, 201);
  } catch (e) {
    return handleApiError(e);
  }
}
