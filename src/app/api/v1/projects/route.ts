import type { NextRequest } from "next/server";
import { z } from "zod";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { createProject, listProjects } from "@/server/data/catalog";
import { handleApiError, ok } from "@/server/http";
import { audit } from "@/server/audit";
import { visibleProjectIds } from "@/server/auth/permissions";
import { prisma } from "@/server/db";

export async function GET(request: NextRequest) { try { const actor=await resolveActor(request); const ids=await visibleProjectIds(actor); return ok(ids===null?await listProjects():await prisma.project.findMany({where:{id:{in:ids},active:true},include:{datasets:{where:{active:true},include:{tables:true}}},orderBy:{name:"asc"}})); } catch (e) { return handleApiError(e); } }
export async function POST(request: NextRequest) { try { const actor=await resolveActor(request); requireRole(actor,["ADMIN","DATA_MANAGER"]); const input=z.object({name:z.string().min(2).max(255),description:z.string().max(1000).optional()}).parse(await request.json()); const project=await createProject(input); await audit(actor,"PROJECT_CREATED","project",project.id,{method:"POST",fields:Object.keys(input)}); return ok(project,undefined,201); } catch(e){ return handleApiError(e); } }