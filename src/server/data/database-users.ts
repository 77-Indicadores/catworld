import { randomBytes } from "node:crypto";
import { prisma } from "@/server/db";
import { encryptSecret } from "@/server/security/crypto";
import { createExternalDatabaseUser,dropExternalDatabaseUser,grantSchema,rotateExternalDatabaseUser } from "@/server/azure/sql";
import { grantTargets } from "@/server/auth/sync-grants";
import { sqlIdentifier } from "@/server/security/naming";

const password=()=>`${randomBytes(18).toString("base64url")}!9a`;
export async function createDatabaseUser(input:{name:string;kind:string;scopeType:"GLOBAL"|"PROJECT"|"DATASET";projectId?:string;datasetId?:string;permission:"READ"|"WRITE"}){
 const name=sqlIdentifier(input.name),secret=password(); await createExternalDatabaseUser(name,secret);
 const user=await prisma.databaseUser.create({data:{name,kind:input.kind,encryptedPassword:encryptSecret(secret)}});
 await prisma.accessGrant.create({data:{databaseUserId:user.id,scopeType:input.scopeType,projectId:input.projectId,datasetId:input.datasetId,permission:input.permission}});
 for(const dataset of await grantTargets(input))await grantSchema(name,dataset.schemaName,input.permission,dataset.storageServerId);
 return {user,secret};
}
export async function rotateDatabaseUser(id:string){const user=await prisma.databaseUser.findUniqueOrThrow({where:{id}}),secret=password();await rotateExternalDatabaseUser(user.name,secret);await prisma.databaseUser.update({where:{id},data:{encryptedPassword:encryptSecret(secret)}});return {user,secret};}
export async function revokeDatabaseUser(id:string){const user=await prisma.databaseUser.findUniqueOrThrow({where:{id}});await dropExternalDatabaseUser(user.name);return prisma.databaseUser.update({where:{id},data:{active:false}});}