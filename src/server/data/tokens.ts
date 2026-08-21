import { randomBytes } from "node:crypto";
import { prisma } from "@/server/db";
import { hashToken } from "@/server/security/crypto";
import { ensureInternalPrincipal, grantSchema } from "@/server/azure/sql";
import { grantTargets } from "@/server/auth/sync-grants";

export async function createToken(input:{name:string;scopeType:"GLOBAL"|"PROJECT"|"DATASET";projectId?:string;datasetId?:string;permission:"READ"|"WRITE";expiresAt?:Date|null}){
  const raw=`cw_live_${randomBytes(24).toString("base64url")}`, prefix=`${raw.slice(0,16)}...`;
  const token=await prisma.apiToken.create({data:{name:input.name,prefix,tokenHash:hashToken(raw),expiresAt:input.expiresAt??null}});
  await prisma.accessGrant.create({data:{tokenId:token.id,scopeType:input.scopeType,projectId:input.projectId,datasetId:input.datasetId,permission:input.permission}});
  const principal=`cw_t_${token.id.replaceAll("-","").slice(0,24)}`; await ensureInternalPrincipal(principal,undefined);
  for(const dataset of await grantTargets(input))await grantSchema(principal,dataset.schemaName,input.permission,dataset.storageServerId);
  return {token,secret:raw};
}