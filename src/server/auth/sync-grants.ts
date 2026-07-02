import { prisma } from "@/server/db";
import type { Actor } from "./actor";
import { ensureInternalPrincipal, grantSchema } from "@/server/azure/sql";

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, number>();

export async function syncActorGrants(actor: Actor) {
  const now = Date.now();
  const cached = cache.get(actor.principal);
  if (cached && now - cached < CACHE_TTL_MS) return;

  await ensureInternalPrincipal(actor.principal);
  const datasets = actor.type === "user" && actor.role === "ADMIN"
    ? (await prisma.dataset.findMany({ where: { active: true } })).map(d => ({ schemaName: d.schemaName, permission: "WRITE" as const }))
    : await datasetsForActor(actor);
  for (const item of datasets) await grantSchema(actor.principal, item.schemaName, item.permission);

  cache.set(actor.principal, now);
  return datasets;
}

export function invalidateSyncCache(principal?: string) {
  if (principal) cache.delete(principal);
  else cache.clear();
}

async function datasetsForActor(actor: Actor) {
  const grants = await prisma.accessGrant.findMany({ where: actor.type === "user" ? { userId: actor.id } : { tokenId: actor.id } });
  const all = await prisma.dataset.findMany({ where: { active: true } });
  const byId = new Map<string, { schemaName: string; permission: "READ" | "WRITE" }>();
  for (const grant of grants) {
    const matching = grant.scopeType === "GLOBAL" ? all : grant.scopeType === "PROJECT" ? all.filter(d => d.projectId === grant.projectId) : all.filter(d => d.id === grant.datasetId);
    for (const d of matching) { const p = grant.permission === "WRITE" || grant.permission === "ADMIN" ? "WRITE" : "READ"; const old = byId.get(d.id); if (!old || p === "WRITE") byId.set(d.id, { schemaName: d.schemaName, permission: p }); }
  }
  return [...byId.values()];
}

export async function grantTargets(input: { scopeType: string; projectId?: string | null; datasetId?: string | null }) {
  if (input.scopeType === "GLOBAL") return prisma.dataset.findMany({ where: { active: true } });
  if (input.scopeType === "PROJECT") return prisma.dataset.findMany({ where: { projectId: input.projectId!, active: true } });
  return prisma.dataset.findMany({ where: { id: input.datasetId!, active: true } });
}
