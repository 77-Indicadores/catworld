import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { encryptSecret } from "@/server/security/crypto";
import { handleApiError, ok } from "@/server/http";

const visible = {
  id: true,
  name: true,
  provider: true,
  environment: true,
  server: true,
  port: true,
  databaseName: true,
  sslMode: true,
  username: true,
  active: true,
  lastStatus: true,
  lastLatencyMs: true,
  lastCheckedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveActor(request);
    requireRole(actor, ["ADMIN"]);
    return ok(await prisma.connection.findMany({ orderBy: { createdAt: "desc" }, select: visible }));
  } catch (e) {
    return handleApiError(e);
  }
}

export async function POST(request: NextRequest) {
  try {
    const actor = await resolveActor(request);
    requireRole(actor, ["ADMIN"]);
    const input = z.object({
      provider: z.literal("postgres").default("postgres"),
      name: z.string().min(2),
      environment: z.enum(["Produção", "Homologação", "Desenvolvimento"]),
      server: z.string().min(3),
      port: z.coerce.number().int().min(1).max(65535).default(5432),
      databaseName: z.string().min(1),
      sslMode: z.enum(["disable", "require", "verify-full"]).default("require"),
      username: z.string().min(1),
      password: z.string().min(1),
    }).parse(await request.json());
    const { password, ...data } = input;
    return ok(await prisma.connection.create({
      data: { ...data, encryptedCredentials: encryptSecret(JSON.stringify({ password })) },
      select: visible,
    }), undefined, 201);
  } catch (e) {
    return handleApiError(e);
  }
}
