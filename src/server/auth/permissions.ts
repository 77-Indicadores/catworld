import { prisma } from "@/server/db";
import type { Actor } from "./actor";
import { ApiError } from "@/server/http";

export async function canAccess(actor: Actor, permission: "READ" | "WRITE", projectId?: string, datasetId?: string) {
  if (actor.type === "user" && actor.role === "ADMIN") return true;
  const grants = await prisma.accessGrant.findMany({ where: actor.type === "user" ? { userId: actor.id } : { tokenId: actor.id } });
  return grants.some((grant) => {
    const allowed = grant.permission === "ADMIN" || grant.permission === permission || (grant.permission === "WRITE" && permission === "READ");
    if (!allowed) return false;
    if (grant.scopeType === "GLOBAL") return true;
    if (grant.scopeType === "PROJECT") return Boolean(projectId && grant.projectId === projectId);
    return Boolean(datasetId && grant.datasetId === datasetId);
  });
}
/** Lanca 403 FORBIDDEN se o ator nao tem a permissao no dataset (mesmo criterio de canAccess). */
export async function assertDatasetAccess(actor: Actor, permission: "READ" | "WRITE", dataset: { id: string; projectId: string }) {
  if (!(await canAccess(actor, permission, dataset.projectId, dataset.id))) {
    throw new ApiError(403, "FORBIDDEN", "Sem permissão no dataset");
  }
}
export async function hasAnyWriteGrant(actor: Actor): Promise<boolean> {
  if (actor.type === "user" && ["ADMIN", "DATA_MANAGER"].includes(actor.role)) return true;
  const grants = await prisma.accessGrant.findMany({ where: actor.type === "user" ? { userId: actor.id } : { tokenId: actor.id } });
  return grants.some((g) => g.permission === "WRITE" || g.permission === "ADMIN");
}
export async function visibleDatasetIds(actor:Actor):Promise<string[]|null>{
 if(actor.type==="user"&&["ADMIN","DATA_MANAGER"].includes(actor.role))return null;
 const grants=await prisma.accessGrant.findMany({where:actor.type==="user"?{userId:actor.id}:{tokenId:actor.id}});
 if(grants.some(g=>g.scopeType==="GLOBAL"))return null;
 const direct=grants.flatMap(g=>g.datasetId?[g.datasetId]:[]),projects=grants.flatMap(g=>g.projectId?[g.projectId]:[]);
 const projectDatasets=projects.length?await prisma.dataset.findMany({where:{projectId:{in:projects}},select:{id:true}}):[];
 return [...new Set([...direct,...projectDatasets.map(d=>d.id)])];
}
export async function visibleProjectIds(actor:Actor):Promise<string[]|null>{const datasetIds=await visibleDatasetIds(actor);if(datasetIds===null)return null;const datasets=await prisma.dataset.findMany({where:{id:{in:datasetIds}},select:{projectId:true}});return [...new Set(datasets.map(d=>d.projectId))]}