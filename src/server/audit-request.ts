/**
 * Auditoria por requisicao — cobre o sistema inteiro:
 *  - `API_WRITE`     toda escrita autenticada (POST/PATCH/PUT/DELETE que muda estado); vira success=false se a
 *                    requisicao terminar em erro (handleApiError);
 *  - `DATA_READ`     leitura de DADOS (OData, linhas de tabela, exportacao, consulta em fonte live) — no maximo 1 por
 *                    ator+rota por minuto (paginacao pesada nao inunda a trilha);
 *  - `ADMIN_READ`    leitura de areas sensiveis (tokens, usuarios, usuarios SQL, conexoes, servidores, auditoria);
 *  - `ACCESS_DENIED` 403/429 em qualquer metodo (quando nao ha evento de escrita);
 *  - `AUTH_FAILED`   401 (limite por IP).
 * Login/logout (`LOGIN_*`, `LOGOUT`) e o ciclo de vida do worker (`JOB_*`) usam os helpers deste modulo.
 * Nunca guarda corpo/query string/cabecalhos, e uma falha ao gravar auditoria nunca derruba a requisicao.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";

type Actor = { type: "user" | "token"; id: string };
type Store = { kind: string | null; eventId: Promise<string | null> | null; actor: Actor | null; method: string; path: string; ip: string | null };
const als = new AsyncLocalStorage<Store>();

const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);
/** POSTs que so leem/testam (nao mudam estado): nao contam como escrita. */
const READ_ONLY_POST = /\/(queries(\/export)?|query|test)$|^\/api\/v1\/(queries|connections\/test)/;
const DATA_READ = /^\/api\/odata\/|^\/api\/v1\/tables\/[^/]+\/rows$|^\/api\/v1\/queries(\/export)?$|^\/api\/v1\/dataset-sources\/[^/]+\/query$/;
const ADMIN_READ = /^\/api\/v1\/(tokens|users|database-users|connections|storage-servers|audit-events|settings|workers|worker-profiles|system)(\/|$)/;
const THROTTLE_MS = 60_000;

export function clientIp(request: { headers: Headers }): string | null {
  const fwd = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (fwd || request.headers.get("x-real-ip") || null)?.slice(0, 64) ?? null;
}

export function isAuditedWrite(method: string, pathname: string): boolean {
  return MUTATING.has(method) && !READ_ONLY_POST.test(pathname);
}

/** Classifica a requisicao (null = nao gera evento de sucesso). */
export function classifyRequest(method: string, pathname: string): "API_WRITE" | "DATA_READ" | "ADMIN_READ" | null {
  if (isAuditedWrite(method, pathname)) return "API_WRITE";
  // QUERY_EXECUTED (queries/route.ts) ja registra as consultas SQL; aqui ficam os demais acessos a dados.
  if (DATA_READ.test(pathname) && !/^\/api\/v1\/queries$/.test(pathname)) return "DATA_READ";
  if (method === "GET" && ADMIN_READ.test(pathname)) return "ADMIN_READ";
  return null;
}

const seen = new Map<string, number>();
function throttled(key: string, windowMs = THROTTLE_MS): boolean {
  const now = Date.now();
  if (now - (seen.get(key) ?? 0) < windowMs) return true;
  seen.set(key, now);
  if (seen.size > 10_000) seen.clear();
  return false;
}

function actorFields(actor: Actor | null) {
  return { userId: actor?.type === "user" ? actor.id : null, tokenId: actor?.type === "token" ? actor.id : null };
}

function record(data: Parameters<typeof prisma.auditEvent.create>[0]["data"]): Promise<string | null> {
  return prisma.auditEvent
    .create({ data, select: { id: true } })
    .then((e) => e.id)
    .catch((e) => {
      console.warn("[audit] falha ao gravar evento: %s", e instanceof Error ? e.message : e);
      return null;
    });
}

/**
 * Nomes (nunca valores) dos campos do corpo JSON de uma escrita: "o que mudou" (ex.: ["role","active"]) sem gravar
 * dado nem segredo. So corpo JSON pequeno; upload/stream de arquivo nao e tocado.
 */
async function bodyFieldNames(request: NextRequest, kind: string): Promise<string[] | null> {
  try {
    if (kind !== "API_WRITE" || !request.headers.get("content-type")?.includes("application/json")) return null;
    if (Number(request.headers.get("content-length") ?? "0") > 64 * 1024) return null;
    const body: unknown = await request.clone().json();
    return body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body).slice(0, 30) : null;
  } catch {
    return null;
  }
}

/**
 * Abre o contexto da requisicao. DEVE ser chamado de forma SINCRONA no inicio de resolveActor (antes de qualquer
 * await): enterWith feito depois de um await nao chega ao handler que aguarda resolveActor.
 */
export function auditRequestBegin(request?: NextRequest): Store {
  const store: Store = { kind: null, eventId: null, actor: null, method: "", path: "", ip: null };
  try {
    if (request) {
      store.method = request.method;
      store.path = request.nextUrl.pathname;
      store.ip = clientIp(request);
    }
  } catch {
    // auditoria nunca derruba a requisicao
  }
  als.enterWith(store);
  return store;
}

export function auditRequestStart(store: Store, request: NextRequest, actor: Actor): void {
  try {
    store.actor = actor;
    const kind = classifyRequest(request.method, request.nextUrl.pathname);
    if (!kind) return;
    store.kind = kind;
    const { pathname } = request.nextUrl;
    if (kind !== "API_WRITE" && throttled(`${kind}:${actor.type}:${actor.id}:${pathname}`)) return;
    store.eventId = bodyFieldNames(request, kind).then((fields) => record({
      ...actorFields(actor),
      eventType: kind,
      resourceType: "route",
      resourceId: pathname.slice(0, 255),
      detailJson: JSON.stringify({ method: request.method, ...(fields ? { fields } : {}) }),
      ipAddress: clientIp(request),
      success: true,
    }));
  } catch {
    // auditoria nunca derruba a requisicao
  }
}

/** Chamado por handleApiError: marca o evento da requisicao atual como falho (ou registra a negacao de acesso). */
export function auditRequestFailed(status: number, code: string): void {
  try {
    const store = als.getStore();
    if (!store) return;
    if (store.eventId) {
      void store.eventId
        .then(async (id) => {
          if (id) await prisma.auditEvent.update({ where: { id }, data: { success: false, ...(store.kind !== "API_WRITE" && (status === 403 || status === 429) ? { eventType: "ACCESS_DENIED" } : {}), detailJson: JSON.stringify({ method: store.method, status, code }) } });
        })
        .catch(() => undefined);
      return;
    }
    if ((status === 403 || status === 429) && store.actor && store.path && !throttled(`DENIED:${store.actor.id}:${store.path}:${status}`)) {
      void record({
        ...actorFields(store.actor),
        eventType: "ACCESS_DENIED",
        resourceType: "route",
        resourceId: store.path.slice(0, 255),
        detailJson: JSON.stringify({ method: store.method, status, code }),
        ipAddress: store.ip,
        success: false,
      });
    }
  } catch {
    // auditoria nunca derruba a requisicao
  }
}

export function auditAuthFailure(request: NextRequest, code: string): void {
  try {
    const ip = clientIp(request) ?? "unknown";
    if (throttled(`AUTH:${ip}`, 10_000)) return; // no maximo 1 evento por IP a cada 10s
    void record({
      eventType: "AUTH_FAILED",
      resourceType: "route",
      resourceId: request.nextUrl.pathname.slice(0, 255),
      detailJson: JSON.stringify({ method: request.method, code }),
      ipAddress: ip === "unknown" ? null : ip,
      success: false,
    });
  } catch {
    // auditoria nunca derruba a requisicao
  }
}

/** Login/logout. `email` so e gravado em tentativa falha de usuario desconhecido (sem senha, nunca). */
export function auditLogin(event: "LOGIN_SUCCESS" | "LOGIN_FAILED" | "LOGOUT", info: { userId?: string | null; email?: string | null; ip?: string | null; reason?: string }): void {
  try {
    if (event === "LOGIN_FAILED" && throttled(`LOGIN:${info.ip ?? "?"}:${info.email ?? "?"}`, 10_000)) return;
    void record({
      userId: info.userId ?? null,
      eventType: event,
      resourceType: "auth",
      resourceId: info.email?.slice(0, 255) ?? null,
      detailJson: info.reason ? JSON.stringify({ reason: info.reason }) : null,
      ipAddress: info.ip?.slice(0, 64) ?? null,
      success: event !== "LOGIN_FAILED",
    });
  } catch {
    // auditoria nunca derruba a requisicao
  }
}

/** Ciclo de vida do worker (jobs): quem executou, quanto durou, se vai repetir. */
export async function auditJob(info: {
  jobId: string;
  jobType: string;
  success: boolean;
  workerLabel: string;
  durationMs: number;
  attempts?: number;
  willRetry?: boolean;
  resourceType?: string;
  resourceId?: string | null;
  error?: string;
}): Promise<void> {
  try {
    await record({
      eventType: info.success ? "JOB_COMPLETED" : "JOB_FAILED",
      resourceType: info.resourceType ?? "job",
      resourceId: (info.resourceId ?? info.jobId).slice(0, 255),
      detailJson: JSON.stringify({
        jobId: info.jobId, type: info.jobType, worker: info.workerLabel, durationMs: info.durationMs,
        ...(info.attempts !== undefined ? { attempts: info.attempts } : {}),
        ...(info.willRetry !== undefined ? { willRetry: info.willRetry } : {}),
        ...(info.error ? { error: info.error.slice(0, 500) } : {}),
      }),
      success: info.success,
    });
  } catch {
    // auditoria nunca derruba o worker
  }
}

/** Leitura de uma pagina administrativa renderizada no servidor (ex.: tela de Auditoria): 1 evento por ator+pagina por minuto. */

export function auditPageRead(actor: Actor, page: string): void {

  try {

    if (throttled(`PAGE:${actor.id}:${page}`)) return;

    void record({ ...actorFields(actor), eventType: "ADMIN_READ", resourceType: "page", resourceId: page.slice(0, 255), detailJson: JSON.stringify({ method: "GET" }), success: true });

  } catch {

    // auditoria nunca derruba a requisicao

  }

}
