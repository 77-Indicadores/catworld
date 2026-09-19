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
export type ScopeDataset = { id: string; projectId: string; schemaName: string; storageServerId: string | null };

/** Todos os datasets ativos que o ator pode LER (qualquer grant que alcance o dataset; ADMIN = todos). */
export async function accessibleDatasets(actor: Actor): Promise<ScopeDataset[]> {
  const all = await prisma.dataset.findMany({
    where: { active: true },
    select: { id: true, projectId: true, schemaName: true, storageServerId: true },
  });
  if (actor.type === "user" && actor.role === "ADMIN") return all;
  const grants = await prisma.accessGrant.findMany({ where: actor.type === "user" ? { userId: actor.id } : { tokenId: actor.id } });
  return all.filter((d) => grants.some((g) =>
    g.scopeType === "GLOBAL" ||
    (g.scopeType === "PROJECT" && g.projectId === d.projectId) ||
    (g.scopeType === "DATASET" && g.datasetId === d.id),
  ));
}

/**
 * Escopo de uma consulta SQL: quais datasets ela pode enxergar. Lanca 403/404 — antes /queries nao
 * conferia acesso nenhum (no Postgres qualquer ator autenticado lia qualquer schema).
 *  - datasetId: o dataset (403 sem acesso, 404 se nao existir)
 *  - projectId: os datasets do projeto a que o ator tem acesso
 *  - nenhum: nomes qualificados; admin = sem restricao, os demais so o que os grants alcancam (403 se nada)
 */
export async function resolveQueryScope(
  actor: Actor,
  input: { datasetId?: string; projectId?: string },
): Promise<{ datasets: ScopeDataset[]; accessible: ScopeDataset[]; unrestricted: boolean }> {
  const accessible = await accessibleDatasets(actor);
  const isAdmin = actor.type === "user" && actor.role === "ADMIN";
  const byId = new Set(accessible.map((d) => d.id));

  if (input.datasetId) {
    const d = await prisma.dataset.findUnique({
      where: { id: input.datasetId, active: true },
      select: { id: true, projectId: true, schemaName: true, storageServerId: true },
    });
    if (!d) throw new ApiError(404, "NOT_FOUND", "Dataset nao encontrado");
    if (!byId.has(d.id)) throw new ApiError(403, "FORBIDDEN", "Sem permissão no dataset");
    return { datasets: [d], accessible, unrestricted: false };
  }
  if (input.projectId) {
    const inProject = await prisma.dataset.findMany({
      where: { projectId: input.projectId, active: true },
      select: { id: true, projectId: true, schemaName: true, storageServerId: true },
    });
    if (!inProject.length) throw new ApiError(404, "NOT_FOUND", "Nenhum dataset encontrado para este projeto");
    const allowed = inProject.filter((d) => byId.has(d.id));
    if (!allowed.length) throw new ApiError(403, "FORBIDDEN", "Sem permissão no projeto");
    return { datasets: allowed, accessible, unrestricted: false };
  }
  // Sem escopo: o SQL usa nomes qualificados (schemas vazios, como sempre). O que o ator ENXERGA e
  // limitado pelo banco (papel no Postgres / grants no SQL Server), nao pelo search_path.
  if (!isAdmin && !accessible.length) throw new ApiError(403, "FORBIDDEN", "Sem acesso a nenhum dataset");
  return { datasets: [], accessible, unrestricted: isAdmin };
}

/** Visibilidade de METADADOS de dataset (a mesma regra das listagens: visibleDatasetIds). */
export async function canSeeDataset(actor: Actor, datasetId: string): Promise<boolean> {
  const ids = await visibleDatasetIds(actor);
  return ids === null || ids.includes(datasetId);
}

/**
 * Uma conexao guarda a credencial de um banco de cliente; quem cria uma fonte roda SQL nela. Antes qualquer um
 * com WRITE num dataset podia apontar uma fonte para QUALQUER conexao e ler o que ela alcanca.
 *  - ADMIN e DATA_MANAGER (usuarios): livres;
 *  - demais (tokens, ANALYST, VIEWER com WRITE): so conexoes que o PROJETO ja usa em alguma fonte
 *    (setups existentes seguem funcionando; nao ha como "pular" para uma conexao nova).
 */
export async function assertCanUseConnection(actor: Actor, connectionId: string, dataset: { id: string; projectId: string }) {
  if (actor.type === "user" && ["ADMIN", "DATA_MANAGER"].includes(actor.role)) return;
  const inUse = await prisma.datasetSource.findFirst({
    where: { connectionId, dataset: { projectId: dataset.projectId } },
    select: { id: true },
  });
  if (!inUse) throw new ApiError(403, "CONNECTION_FORBIDDEN", "Sem permissão para usar esta conexão (peça a um administrador)");
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