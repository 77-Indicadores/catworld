import { ZodError } from "zod";
import { randomUUID } from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";

export function ok<T>(data: T, meta?: Record<string, unknown>, status = 200) {
  return NextResponse.json({ data: serialize(data), meta: meta ?? null, error: null }, { status });
}
export function fail(status: number, code: string, message: string, details?: unknown) {
  return NextResponse.json({ data: null, meta: null, error: { code, message, details: details ?? null } }, { status });
}
export function serialize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item));
}
/** Mensagem de driver que revela infraestrutura (host, IP do cliente, firewall) — nao vai para o cliente. */
const CONNECTION_ERROR = /(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|getaddrinfo|Failed to connect|Cannot open server|Login failed|not allowed to access the server|firewall|socket hang up|Connection lost)/i;

/** Erro do banco de STORAGE: o texto do SQL do usuario (sintaxe, coluna...) e util; erro de conexao nao. */
export function publicQueryErrorMessage(message: string): string {
  return CONNECTION_ERROR.test(message) ? "Falha ao conectar ao banco de dados. Tente novamente em instantes." : message;
}

export async function handleApiError(error: unknown, context?: Record<string, unknown>) {
  if (error instanceof ApiError) {
    const res = fail(error.status, error.code, error.message, error.details);
    const retry = (error.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
    if (error.status === 429 && retry) res.headers.set("Retry-After", String(retry));
    return res;
  }
  // Entrada invalida e erro do CLIENTE (400), nao falha do servidor: nao vai para o Sentry.
  if (error instanceof ZodError) {
    return fail(400, "VALIDATION_ERROR", "Requisição inválida.", {
      issues: error.issues.map((i) => ({ path: i.path.join("."), code: i.code, message: i.message })),
    });
  }
  if (error instanceof SyntaxError && /JSON|Unexpected (token|end)|Expected /i.test(error.message)) {
    return fail(400, "INVALID_JSON", "O corpo da requisição não é um JSON válido.");
  }
  // Falha real: o detalhe fica no log/Sentry, com um identificador que o cliente pode informar ao suporte.
  const errorId = randomUUID().slice(0, 8);
  Sentry.withScope((scope) => {
    scope.setTag("error_id", errorId);
    if (context) scope.setContext("request_context", context);
    Sentry.captureException(error);
  });
  console.error(`[api] erro interno ${errorId}:`, error);
  // Sem await: nao segura a resposta por ate 2s esperando o Sentry.
  void Sentry.flush(2000).catch(() => undefined);
  return fail(500, "INTERNAL_ERROR", "Erro interno do servidor.", { errorId });
}
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}
