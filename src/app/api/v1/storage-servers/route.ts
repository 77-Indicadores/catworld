import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { handleApiError, ok } from "@/server/http";

const visible = {
  id: true,
  name: true,
  url: true,
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

    // Se isDefault, remove o flag dos demais
    if (input.isDefault) {
      await prisma.storageServer.updateMany({ data: { isDefault: false } });
    }

    const server = await prisma.storageServer.create({
      data: {
        id: crypto.randomUUID(),
        name: input.name,
        url: input.url,
        isDefault: input.isDefault ?? false,
        active: input.active ?? true,
        provider: "sqlserver",
        server: "",
        port: 1433,
        databaseName: "",
        encryptedCredentials: "",
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
