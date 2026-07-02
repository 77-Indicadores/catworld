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
export function handleApiError(error: unknown) {
  if (error instanceof ApiError) return fail(error.status, error.code, error.message, error.details);
  console.error("[handleApiError]", error);
  Sentry.captureException(error);
  return fail(500, "INTERNAL_ERROR", "Erro interno inesperado");
}
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}