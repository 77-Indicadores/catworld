import type { NextRequest } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/server/db";
import { ApiError } from "@/server/http";
import { hashToken } from "@/server/security/crypto";
import { TtlCache } from "@/server/cache/ttl-cache";
import { auditAuthFailure, auditRequestBegin, auditRequestStart } from "@/server/audit-request";
import { checkRateLimit } from "@/server/query/protection";

export type Actor = { type: "user" | "token"; id: string; role: string; principal: string };

// Revogacao de sessao: o JWT dura 8h, entao consultamos o usuario (cache curto) — desativar ou mudar o papel
// vale em ate 10s (na hora, na instancia que fez a alteracao: invalidateActorCache).
const userCache = new TtlCache<string, { active: boolean; role: string } | null>(10_000, 500);

export function invalidateActorCache(userId?: string) {
  userCache.deleteWhere((k) => userId === undefined || k === userId);
}

async function currentUser(id: string) {
  const hit = userCache.get(id);
  if (hit !== null) return hit;
  const user = await prisma.user.findUnique({ where: { id }, select: { active: true, role: true } });
  userCache.set(id, user ?? { active: false, role: "" });
  return user ?? { active: false, role: "" };
}

const TOKEN_TOUCH_MS = 60_000; // lastUsedAt: no maximo 1 escrita por minuto por token

/** `rateLimit: false` so para caminhos que paginam pesado por natureza (OData). */
export async function resolveActor(request?: NextRequest, opts: { rateLimit?: boolean; audit?: boolean } = {}): Promise<Actor> {
  const auditStore = request && opts.audit !== false ? auditRequestBegin(request) : null;
  let actor: Actor;
  try {
    actor = await identify(request);
  } catch (e) {
    if (request && opts.audit !== false && e instanceof ApiError && e.status === 401) auditAuthFailure(request, e.code);
    throw e;
  }
  if (request && auditStore) auditRequestStart(auditStore, request, actor);
  if (request && opts.rateLimit !== false) checkRateLimit(actor.principal, "default");
  return actor;
}

async function identify(request?: NextRequest): Promise<Actor> {
  const bearer = request?.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) {
    const token = await prisma.apiToken.findUnique({ where: { tokenHash: hashToken(bearer) } });
    if (!token?.active || (token.expiresAt && token.expiresAt <= new Date())) throw new ApiError(401, "INVALID_TOKEN", "Token inválido, expirado ou revogado");
    if (!token.lastUsedAt || Date.now() - token.lastUsedAt.getTime() > TOKEN_TOUCH_MS) {
      await prisma.apiToken.update({ where: { id: token.id }, data: { lastUsedAt: new Date() } });
    }
    return { type: "token", id: token.id, role: "TOKEN", principal: `cw_t_${token.id.replaceAll("-", "").slice(0, 24)}` };
  }
  const session = await auth();
  if (!session?.user?.id) throw new ApiError(401, "UNAUTHENTICATED", "Autenticação necessária");
  const user = await currentUser(session.user.id);
  if (!user.active) throw new ApiError(401, "UNAUTHENTICATED", "Sessão inválida ou usuário desativado");
  return { type: "user", id: session.user.id, role: user.role, principal: `cw_u_${session.user.id.replaceAll("-", "").slice(0, 24)}` };
}

export function requireRole(actor: Actor, roles: string[]) {
  if (!roles.includes(actor.role)) throw new ApiError(403, "FORBIDDEN", "Permissão insuficiente");
}