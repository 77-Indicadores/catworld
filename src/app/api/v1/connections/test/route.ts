import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { encryptSecret } from "@/server/security/crypto";
import { handleApiError, ok } from "@/server/http";
import { testPostgres } from "@/server/connections/postgres";
import { testMssql } from "@/server/connections/mssql";

const postgresSchema = z.object({
  provider: z.literal("postgres"),
  server: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535).default(5432),
  databaseName: z.string().min(1),
  sslMode: z.enum(["disable", "require", "verify-full"]).default("require"),
  username: z.string().min(1),
  password: z.string().min(1),
});

const mssqlSchema = z.object({
  provider: z.literal("mssql"),
  server: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535).default(1433),
  databaseName: z.string().min(1),
  encrypt: z.boolean().default(true),
  trustServerCert: z.boolean().default(false),
  username: z.string().min(1),
  password: z.string().min(1),
});

export async function POST(request: NextRequest) {
  try {
    const actor = await resolveActor(request);
    requireRole(actor, ["ADMIN"]);
    const raw = await request.json() as Record<string, unknown>;
    const providerRaw = raw?.provider ?? "postgres";

    // Edit mode: no new password — look up encrypted credentials from the saved connection
    if (raw.connectionId && !raw.password) {
      const editSchema = z.object({
        connectionId: z.string().min(1),
        server: z.string().min(1),
        port: z.coerce.number().int().min(1).max(65535),
        databaseName: z.string().min(1),
        username: z.string().min(1),
        // mssql-specific TLS overrides (optional — fall back to stored sslMode)
        encrypt: z.boolean().optional(),
        trustServerCert: z.boolean().optional(),
      });
      const edit = editSchema.parse(raw);
      const existing = await prisma.connection.findUniqueOrThrow({
        where: { id: edit.connectionId },
        select: { encryptedCredentials: true, provider: true, sslMode: true },
      });
      // For mssql: honour any TLS checkbox overrides from the form; otherwise keep stored sslMode
      let sslMode = existing.sslMode;
      if (existing.provider === "mssql" && (edit.encrypt !== undefined || edit.trustServerCert !== undefined)) {
        const enc = edit.encrypt ?? existing.sslMode.startsWith("no-") === false;
        const trust = edit.trustServerCert ?? existing.sslMode.includes("trust");
        sslMode = enc ? (trust ? "encrypt-trust" : "encrypt") : (trust ? "no-encrypt-trust" : "no-encrypt");
      }
      const conn = { ...edit, provider: existing.provider, sslMode, encryptedCredentials: existing.encryptedCredentials };
      const result = existing.provider === "mssql" ? await testMssql(conn) : await testPostgres(conn);
      return ok({ healthy: true, ...result });
    }

    if (providerRaw === "mssql") {
      const input = mssqlSchema.parse(raw);
      const { password, encrypt, trustServerCert, ...rest } = input;
      const sslMode = encrypt ? (trustServerCert ? "encrypt-trust" : "encrypt") : (trustServerCert ? "no-encrypt-trust" : "no-encrypt");
      const conn = { ...rest, sslMode, encryptedCredentials: encryptSecret(JSON.stringify({ password, encrypt, trustServerCert })) };
      const result = await testMssql(conn);
      return ok({ healthy: true, ...result });
    }

    const input = postgresSchema.parse(raw);
    const { password, ...rest } = input;
    const conn = { ...rest, encryptedCredentials: encryptSecret(JSON.stringify({ password })) };
    const result = await testPostgres(conn);
    return ok({ healthy: true, ...result });
  } catch (e) {
    return handleApiError(e);
  }
}
