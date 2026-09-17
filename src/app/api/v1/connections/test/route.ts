import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { encryptSecret } from "@/server/security/crypto";
import { handleApiError, ok } from "@/server/http";
import { testPostgres } from "@/server/connections/postgres";
import { testMssql } from "@/server/connections/mssql";

const sshTunnelSchema = z.object({
  sshTunnelEnabled: z.boolean().default(false),
  sshHost: z.string().min(1).optional(),
  sshPort: z.coerce.number().int().min(1).max(65535).default(22).optional(),
  sshUsername: z.string().min(1).optional(),
  sshAuthMethod: z.enum(["password", "privateKey"]).optional(),
  sshPassword: z.string().optional(),
  sshPrivateKey: z.string().optional(),
  sshPassphrase: z.string().optional(),
});

function buildSshTunnelData(input: z.infer<typeof sshTunnelSchema>) {
  const { sshTunnelEnabled, sshHost, sshPort, sshUsername, sshAuthMethod, sshPassword, sshPrivateKey, sshPassphrase } = input;
  if (!sshTunnelEnabled) return {};
  if (!sshHost || !sshUsername || !sshAuthMethod) throw new Error("Tunel SSH exige host, usuario e metodo de autenticacao");
  const secret = sshAuthMethod === "password" ? { password: sshPassword } : { privateKey: sshPrivateKey, passphrase: sshPassphrase };
  return {
    sshTunnelEnabled: true,
    sshHost, sshPort: sshPort ?? 22, sshUsername, sshAuthMethod,
    sshEncryptedSecret: encryptSecret(JSON.stringify(secret)),
  };
}

const postgresSchema = z.object({
  provider: z.literal("postgres"),
  server: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535).default(5432),
  databaseName: z.string().min(1),
  sslMode: z.enum(["disable", "require", "verify-full"]).default("require"),
  username: z.string().min(1),
  password: z.string().min(1),
}).merge(sshTunnelSchema);

const mssqlSchema = z.object({
  provider: z.literal("mssql"),
  server: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535).default(1433),
  databaseName: z.string().min(1),
  encrypt: z.boolean().default(true),
  trustServerCert: z.boolean().default(false),
  username: z.string().min(1),
  password: z.string().min(1),
}).merge(sshTunnelSchema);

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
      }).merge(sshTunnelSchema);
      const edit = editSchema.parse(raw);
      const existing = await prisma.connection.findUniqueOrThrow({
        where: { id: edit.connectionId },
        select: { encryptedCredentials: true, provider: true, sslMode: true, sshTunnelEnabled: true, sshHost: true, sshPort: true, sshUsername: true, sshAuthMethod: true, sshEncryptedSecret: true },
      });
      // For mssql: honour any TLS checkbox overrides from the form; otherwise keep stored sslMode
      let sslMode = existing.sslMode;
      if (existing.provider === "mssql" && (edit.encrypt !== undefined || edit.trustServerCert !== undefined)) {
        const enc = edit.encrypt ?? existing.sslMode.startsWith("no-") === false;
        const trust = edit.trustServerCert ?? existing.sslMode.includes("trust");
        sslMode = enc ? (trust ? "encrypt-trust" : "encrypt") : (trust ? "no-encrypt-trust" : "no-encrypt");
      }
      // Se o formulario mandou dados novos de tunel, usa-os; senao mantem o tunel ja salvo
      const sshOverride = edit.sshTunnelEnabled ? buildSshTunnelData(edit) : null;
      const conn = {
        ...edit, provider: existing.provider, sslMode, encryptedCredentials: existing.encryptedCredentials,
        ...(sshOverride ?? { sshTunnelEnabled: existing.sshTunnelEnabled, sshHost: existing.sshHost, sshPort: existing.sshPort, sshUsername: existing.sshUsername, sshAuthMethod: existing.sshAuthMethod, sshEncryptedSecret: existing.sshEncryptedSecret }),
      };
      const result = existing.provider === "mssql" ? await testMssql(conn) : await testPostgres(conn);
      return ok({ healthy: true, ...result });
    }

    if (providerRaw === "mssql") {
      const input = mssqlSchema.parse(raw);
      const { password, encrypt, trustServerCert, ...rest } = input;
      const sslMode = encrypt ? (trustServerCert ? "encrypt-trust" : "encrypt") : (trustServerCert ? "no-encrypt-trust" : "no-encrypt");
      const conn = { ...rest, sslMode, encryptedCredentials: encryptSecret(JSON.stringify({ password, encrypt, trustServerCert })), ...buildSshTunnelData(input) };
      const result = await testMssql(conn);
      return ok({ healthy: true, ...result });
    }

    const input = postgresSchema.parse(raw);
    const { password, ...rest } = input;
    const conn = { ...rest, encryptedCredentials: encryptSecret(JSON.stringify({ password })), ...buildSshTunnelData(input) };
    const result = await testPostgres(conn);
    return ok({ healthy: true, ...result });
  } catch (e) {
    return handleApiError(e);
  }
}
