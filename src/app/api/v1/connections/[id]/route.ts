import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { encryptSecret, decryptSecret } from "@/server/security/crypto";
import { handleApiError, ok } from "@/server/http";

const visible = { id: true, name: true, provider: true, environment: true, server: true, port: true, databaseName: true, sslMode: true, username: true, active: true, lastStatus: true, lastLatencyMs: true, lastCheckedAt: true, createdAt: true, updatedAt: true } as const;

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(request);
    requireRole(actor, ["ADMIN"]);
    const id = (await params).id;
    const input = z.object({
      name: z.string().min(2).optional(),
      environment: z.enum(["Produção", "Homologação", "Desenvolvimento"]).optional(),
      server: z.string().min(3).optional(),
      port: z.coerce.number().int().min(1).max(65535).optional(),
      databaseName: z.string().min(1).optional(),
      sslMode: z.enum(["disable", "require", "verify-full", "encrypt", "encrypt-trust", "no-encrypt", "no-encrypt-trust"]).optional(),
      username: z.string().min(1).optional(),
      password: z.string().min(1).optional(),
      encrypt: z.boolean().optional(),
      trustServerCert: z.boolean().optional(),
      active: z.boolean().optional(),
    }).parse(await request.json());
    const { password, encrypt, trustServerCert, ...data } = input;
    let credentialsUpdate: { encryptedCredentials?: string } = {};
    if (password || encrypt !== undefined || trustServerCert !== undefined) {
      const existing = await prisma.connection.findUniqueOrThrow({ where: { id }, select: { encryptedCredentials: true } });
      const current = JSON.parse(decryptSecret(existing.encryptedCredentials)) as Record<string, unknown>;
      if (password) current.password = password;
      if (encrypt !== undefined) current.encrypt = encrypt;
      if (trustServerCert !== undefined) current.trustServerCert = trustServerCert;
      credentialsUpdate = { encryptedCredentials: encryptSecret(JSON.stringify(current)) };
    }
    return ok(await prisma.connection.update({
      where: { id },
      data: { ...data, ...credentialsUpdate },
      select: visible,
    }));
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(request);
    requireRole(actor, ["ADMIN"]);
    return ok(await prisma.connection.update({ where: { id: (await params).id }, data: { active: false }, select: { id: true } }));
  } catch (e) {
    return handleApiError(e);
  }
}
