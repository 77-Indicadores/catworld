import type { NextRequest } from "next/server";
import { visibleDatasetIds } from "@/server/auth/permissions";
import { z } from "zod";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { deleteProject } from "@/server/data/catalog";
import { ApiError, handleApiError, ok } from "@/server/http";
export async function GET(request:NextRequest,{params}:{params:Promise<{id:string}>}){try{
  const actor=await resolveActor(request);
  const project=await prisma.project.findUniqueOrThrow({where:{id:(await params).id},include:{datasets:{where:{active:true},include:{tables:true}}}});
  // Antes listava TODOS os datasets do projeto para qualquer login: agora so os que o ator pode ver (mesma regra das listagens).
  const ids=await visibleDatasetIds(actor);
  const datasets=ids===null?project.datasets:project.datasets.filter((d)=>ids.includes(d.id));
  if(ids!==null&&datasets.length===0&&project.datasets.length>0)throw new ApiError(403,"FORBIDDEN","Sem permissão no projeto");
  return ok({...project,datasets});}catch(e){return handleApiError(e)}}
export async function PATCH(request:NextRequest,{params}:{params:Promise<{id:string}>}){try{const actor=await resolveActor(request);requireRole(actor,["ADMIN","DATA_MANAGER"]);const input=z.object({name:z.string().min(2).max(255).optional(),description:z.string().max(1000).nullable().optional(),active:z.boolean().optional()}).parse(await request.json());return ok(await prisma.project.update({where:{id:(await params).id},data:input}));}catch(e){return handleApiError(e)}}
export async function DELETE(request:NextRequest,{params}:{params:Promise<{id:string}>}){try{const actor=await resolveActor(request);requireRole(actor,["ADMIN"]);const id=(await params).id;const project=await prisma.project.findUniqueOrThrow({where:{id}});const {confirmName}=z.object({confirmName:z.string()}).parse(await request.json());if(confirmName!==project.name)throw new ApiError(400,"CONFIRMATION_MISMATCH","Nome de confirmação não confere");await deleteProject(id);return ok({deleted:true});}catch(e){return handleApiError(e)}}