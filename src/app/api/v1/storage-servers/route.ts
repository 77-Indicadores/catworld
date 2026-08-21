import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { handleApiError, ok } from "@/server/http";
import { encryptSecret } from "@/server/security/crypto";

/** Mascara a senha na URL para exibição. */
function maskUrl(url: string): string {
  return url.replace(/password=[^;]+/gi, "password=••••••••");
}

const visible = {
  id: true,
  name: true,
  url: true,              // campo url armazena versão mascarada para display
  isDefault: true,
  active: true,
  lastStatus: true,
  lastLatencyMs: true,
  lastCheckedAt: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { datasets: true } },
} as const;

const bodySchema = z.object({
  name: z.string().min(2).max(120),
  url: z.string().min(10),
  isDefault: z.boolean().optional(),
  active: z.boolean().optional(),
});

export async function GET(r: NextRequest) {
  try {
    const actor = await resolveActor(r);
    requireRole(actor, ["ADMIN"]);
    return ok(await prisma.storageServer.findMany({ orderBy: { createdAt: "asc" }, select: visible }));
  } catch (e) {
    return handleApiError(e);
  }
}

export async function POST(r: NextRequest) {
  try {
    const actor = await resolveActor(r);
    requireRole(actor, ["ADMIN"]);
    const input = bodySchema.parse(await r.json());

    if (input.isDefault) {
      await prisma.storageServer.updateMany({ data: { isDefault: false } });
    }

    const server = await prisma.storageServer.create({
      data: {
        id: crypto.randomUUID(),
        name: input.name,
        url: maskUrl(input.url),                       // display: mascarado
        encryptedCredentials: encryptSecret(input.url), // storage: criptografado
        isDefault: input.isDefault ?? false,
        active: input.active ?? true,
        provider: "sqlserver",
        server: "",
        port: 1433,
        databaseName: "",
        sslMode: "none",
        encrypt: true,
      },
      select: visible,
    });

    return ok(server, undefined, 201);
  } catch (e) {
    return handleApiError(e);
  }
}
