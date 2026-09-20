/** GET /api/v1/workers — perfis + estado observado (supervisor, filhos, carga) + comandos recentes. ADMIN. */
import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { handleApiError, ok } from "@/server/http";
import { coverageWarnings } from "@/server/worker/profiles";
import { getProfileLoad, getSupervisorStatus } from "@/server/worker/status";

export async function GET(r: NextRequest) {
  try {
    const actor = await resolveActor(r);
    requireRole(actor, ["ADMIN"]);
    const [profiles, supervisor, commands] = await Promise.all([
      prisma.workerProfile.findMany({ orderBy: { name: "asc" } }),
      getSupervisorStatus(),
      prisma.systemCommand.findMany({ orderBy: { requestedAt: "desc" }, take: 10 }),
    ]);
    const load = await getProfileLoad(profiles);
    const children = new Map(supervisor.children.map((c) => [c.name, c]));
    const items = profiles.map((p) => ({
      id: p.id,
      name: p.name,
      jobTypes: p.jobTypes,
      weights: p.weights,
      concurrency: p.concurrency,
      pollMs: p.pollMs,
      duckdbMemoryLimit: p.duckdbMemoryLimit,
      enabled: p.enabled,
      revision: p.revision,
      runtime: children.get(p.name) ?? null, // null = sem supervisor ou ainda não reconhecido
      ...load.get(p.name),
    }));
    const warnings = coverageWarnings(profiles);
    return ok(
      { supervisor: { supervised: supervisor.supervised, instanceId: supervisor.instanceId, hostname: supervisor.hostname, pid: supervisor.pid, heartbeatAt: supervisor.heartbeatAt }, profiles: items, commands },
      warnings.length ? { warnings } : undefined,
    );
  } catch (e) {
    return handleApiError(e);
  }
}
