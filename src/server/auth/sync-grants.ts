import { prisma } from "@/server/db";
import type { Actor } from "./actor";
import { batchGrantSchemas } from "@/server/azure/sql";

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, number>();
const inProgress = new Map<string, Promise<void>>();

type SyncScope = { datasetIds?: string[]; projectIds?: string[] };

export async function syncActorGrants(actor: Actor, scope?: SyncScope) {
  const now = Date.now();
  const key = cacheKey(actor.principal, scope);
  const cached = cache.get(key);
  if (cached && now - cached < CACHE_TTL_MS) return;

  const running = inProgress.get(key);
  if (running) return running;

  const promise = _doSync(actor, scope).finally(() => inProgress.delete(key));
  inProgress.set(key, promise);
  return promise;
}

async function _doSync(actor: Actor, scope?: SyncScope) {
  const datasets = actor.type === "user" && actor.role === "ADMIN"
    ? (await prisma.dataset.findMany({ where: { active: true, ...scopeWhere(scope) }, select: { schemaName: true, storageServerId: true } })).map(d => ({ schemaName: d.schemaName, storageServerId: d.storageServerId, permission: "WRITE" as const }))
    : await datasetsForActor(actor, scope);

  // Grants de schema só se aplicam a datasets em SQL Server (MSSQL).
  // Datasets em PostgreSQL usam conta única da aplicação — sem usuários por schema.
  // Resolve o provider de cada storageServerId (null = default).
  const storageServers = await prisma.storageServer.findMany({ select: { id: true, provider: true, isDefault: true } });
  const defaultProvider = storageServers.find(s => s.isDefault)?.provider ?? "sqlserver";
  const providerById = new Map(storageServers.map(s => [s.id, s.provider]));

  const mssqlDatasets = datasets.filter(d => {
    const provider = d.storageServerId ? (providerById.get(d.storageServerId) ?? "sqlserver") : defaultProvider;
    return provider === "sqlserver";
  });

  if (mssqlDatasets.length > 0) {
    // Agrupa por storageServerId para usar o pool correto de cada servidor MSSQL
    const byServer = new Map<string | null, typeof mssqlDatasets>();
    for (const d of mssqlDatasets) {
      const key = d.storageServerId;
      if (!byServer.has(key)) byServer.set(key, []);
      byServer.get(key)!.push(d);
    }
    for (const [serverId, group] of byServer) {
      await batchGrantSchemas(actor.principal, group.map(d => ({ schema: d.schemaName, permission: d.permission })), serverId);
    }
  }

  cache.set(cacheKey(actor.principal, scope), Date.now());
}

export function invalidateSyncCache(principal?: string) {
  if (principal) {
    for (const key of cache.keys()) if (key === principal || key.startsWith(`${principal}:`)) cache.delete(key);
  } else cache.clear();
}

async function datasetsForActor(actor: Actor, scope?: SyncScope) {
  const grants = await prisma.accessGrant.findMany({ where: actor.type === "user" ? { userId: actor.id } : { tokenId: actor.id } });
  const all = await prisma.dataset.findMany({ where: { active: true, ...scopeWhere(scope) }, select: { id: true, projectId: true, schemaName: true, storageServerId: true } });
  const byId = new Map<string, { schemaName: string; storageServerId: string | null; permission: "READ" | "WRITE" }>();
  for (const grant of grants) {
    const matching = grant.scopeType === "GLOBAL" ? all : grant.scopeType === "PROJECT" ? all.filter(d => d.projectId === grant.projectId) : all.filter(d => d.id === grant.datasetId);
    for (const d of matching) { const p = grant.permission === "WRITE" || grant.permission === "ADMIN" ? "WRITE" : "READ"; const old = byId.get(d.id); if (!old || p === "WRITE") byId.set(d.id, { schemaName: d.schemaName, storageServerId: d.storageServerId, permission: p }); }
  }
  return [...byId.values()];
}

function scopeWhere(scope?: SyncScope) {
  const clauses = [];
  if (scope?.datasetIds?.length) clauses.push({ id: { in: scope.datasetIds } });
  if (scope?.projectIds?.length) clauses.push({ projectId: { in: scope.projectIds } });
  return clauses.length ? { OR: clauses } : {};
}

function cacheKey(principal: string, scope?: SyncScope) {
  if (!scope) return principal;
  return `${principal}:d=${[...(scope.datasetIds ?? [])].sort().join(",")}:p=${[...(scope.projectIds ?? [])].sort().join(",")}`;
}

export async function grantTargets(input: { scopeType: string; projectId?: string | null; datasetId?: string | null }) {
  if (input.scopeType === "GLOBAL") return prisma.dataset.findMany({ where: { active: true } });
  if (input.scopeType === "PROJECT") return prisma.dataset.findMany({ where: { projectId: input.projectId!, active: true } });
  return prisma.dataset.findMany({ where: { id: input.datasetId!, active: true } });
}
