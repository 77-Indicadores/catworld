/**
 * Auditoria por requisicao: toda escrita autenticada (POST/PATCH/PUT/DELETE que muda estado) gera um evento
 * `API_WRITE` (quem, metodo, rota, IP); se a requisicao terminar em erro, o evento e marcado success=false com o
 * codigo (handleApiError). Falhas de autenticacao geram `AUTH_FAILED` (com limite por IP). Nunca guarda corpo/query
 * string/cabecalhos, e uma falha ao gravar auditoria nunca derruba a requisicao.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";

type Store = { eventId: Promise<string | null> | null };
const als = new AsyncLocalStorage<Store>();

const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);
/** POSTs que so leem/testam (nao mudam estado): fora da trilha para nao gerar ruido. */
const READ_ONLY_POST = /\/(queries(\/export)?|query|test)$|^\/api\/v1\/(queries|connections\/test)/;

export function clientIp(request: NextRequest): string | null {
  const fwd = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (fwd || request.headers.get("x-real-ip") || null)?.slice(0, 64) ?? null;
}

export function isAuditedWrite(method: string, pathname: string): boolean {
  return MUTATING.has(method) && !READ_ONLY_POST.test(pathname);
}

/**
 * Abre o contexto da requisicao. DEVE ser chamado de forma SINCRONA no inicio de resolveActor (antes de qualquer
 * await): enterWith feito depois de um await nao chega ao handler que aguarda resolveActor.
 */
export function auditRequestBegin(): Store {
  const store: Store = { eventId: null };
  als.enterWith(store);
  return store;
}

export function auditRequestStart(store: Store, request: NextRequest, actor: { type: "user" | "token"; id: string }): void {
  const { pathname } = request.nextUrl;
  if (!isAuditedWrite(request.method, pathname)) return;
  store.eventId = prisma.auditEvent
    .create({
      data: {
        userId: actor.type === "user" ? actor.id : null,
        tokenId: actor.type === "token" ? actor.id : null,
        eventType: "API_WRITE",
        resourceType: "route",
        resourceId: pathname.slice(0, 255),
        detailJson: JSON.stringify({ method: request.method }),
        ipAddress: clientIp(request),
        success: true,
      },
      select: { id: true },
    })
    .then((e) => e.id)
    .catch((e) => {
      console.warn("[audit] falha ao gravar evento: %s", e instanceof Error ? e.message : e);
      return null;
    });
}

/** Chamado por handleApiError: marca o evento da requisicao atual como falho. */
export function auditRequestFailed(status: number, code: string): void {
  const store = als.getStore();
  if (!store?.eventId) return;
  void store.eventId
    .then(async (id) => {
      if (id) await prisma.auditEvent.update({ where: { id }, data: { success: false, detailJson: JSON.stringify({ status, code }) } });
    })
    .catch(() => undefined);
}

const authFailSeen = new Map<string, number>();
const AUTH_FAIL_WINDOW_MS = 10_000;

export function auditAuthFailure(request: NextRequest, code: string): void {
  const ip = clientIp(request) ?? "unknown";
  const now = Date.now();
  if (now - (authFailSeen.get(ip) ?? 0) < AUTH_FAIL_WINDOW_MS) return; // no maximo 1 evento por IP a cada 10s
  authFailSeen.set(ip, now);
  if (authFailSeen.size > 5000) authFailSeen.clear();
  void prisma.auditEvent
    .create({
      data: {
        eventType: "AUTH_FAILED",
        resourceType: "route",
        resourceId: request.nextUrl.pathname.slice(0, 255),
        detailJson: JSON.stringify({ method: request.method, code }),
        ipAddress: ip === "unknown" ? null : ip,
        success: false,
      },
    })
    .catch(() => undefined);
}
