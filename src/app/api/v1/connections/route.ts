import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { encryptSecret } from "@/server/security/crypto";
import { handleApiError, ok } from "@/server/http";
import { parseFirebirdFtpConfig } from "@/server/connections/sources";

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
  sshTunnelEnabled: true,
  sshHost: true,
  sshPort: true,
  sshUsername: true,
  sshAuthMethod: true,
  lastStatus: true,
  lastLatencyMs: true,
  lastCheckedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

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
  if (!sshTunnelEnabled) {
    return { sshTunnelEnabled: false, sshHost: null, sshPort: null, sshUsername: null, sshAuthMethod: null, sshEncryptedSecret: null };
  }
  if (!sshHost || !sshUsername || !sshAuthMethod) throw new Error("Tunel SSH exige host, usuario e metodo de autenticacao");
  const secret = sshAuthMethod === "password" ? { password: sshPassword } : { privateKey: sshPrivateKey, passphrase: sshPassphrase };
  return {
    sshTunnelEnabled: true,
    sshHost,
    sshPort: sshPort ?? 22,
    sshUsername,
    sshAuthMethod,
    sshEncryptedSecret: encryptSecret(JSON.stringify(secret)),
  };
}

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
    const postgresSchema = z.object({
      provider: z.literal("postgres").default("postgres"),
      name: z.string().min(2),
      environment: z.enum(["Produção", "Homologação", "Desenvolvimento"]),
      server: z.string().min(3),
      port: z.coerce.number().int().min(1).max(65535).default(5432),
      databaseName: z.string().min(1),
      sslMode: z.enum(["disable", "require", "verify-full"]).default("require"),
      username: z.string().min(1),
      password: z.string().min(1),
    }).merge(sshTunnelSchema);
    const mssqlSchema = z.object({
      provider: z.literal("mssql"),
      name: z.string().min(2),
      environment: z.enum(["Produção", "Homologação", "Desenvolvimento"]),
      server: z.string().min(3),
      port: z.coerce.number().int().min(1).max(65535).default(1433),
      databaseName: z.string().min(1),
      encrypt: z.boolean().default(true),
      trustServerCert: z.boolean().default(false),
      username: z.string().min(1),
      password: z.string().min(1),
    }).merge(sshTunnelSchema);
    // firebird-ftp: "server"/"port"/"username"/"password" sao do FTP (nao do Firebird — o Firebird e sempre o
    // efemero nosso, materializado a partir do backup baixado). remotePath/filePattern dizem onde achar o ZIP;
    // innerFilePattern/charset descrevem o backup dentro do ZIP. Sem tunel SSH aqui: ftp-watch.ts nao suporta.
    const firebirdFtpSchema = z.object({
      provider: z.literal("firebird-ftp"),
      name: z.string().min(2),
      environment: z.enum(["Produção", "Homologação", "Desenvolvimento"]),
      server: z.string().min(1, "host do FTP obrigatorio"),
      port: z.coerce.number().int().min(1).max(65535).default(21),
      username: z.string().min(1, "usuario do FTP obrigatorio"),
      password: z.string().min(1, "senha do FTP obrigatoria"),
      remotePath: z.string().min(1, "caminho remoto obrigatorio"),
      filePattern: z.string().min(1, "padrao do arquivo obrigatorio (ex.: *.zip)"),
      innerFilePattern: z.string().min(1).optional(),
      charset: z.string().min(1).optional(),
    });
    const raw = await request.json();
    const providerRaw = (raw as Record<string, unknown>)?.provider ?? "postgres";
    if (providerRaw === "firebird-ftp") {
      const input = firebirdFtpSchema.parse(raw);
      const { password, remotePath, filePattern, innerFilePattern, charset, ...data } = input;
      const metadataJson = JSON.stringify(
        parseFirebirdFtpConfig(JSON.stringify({
          ftp: { host: input.server, port: input.port, remotePath, filePattern },
          firebird: (innerFilePattern || charset) ? { innerFilePattern, charset } : undefined,
        })),
      );
      return ok(await prisma.connection.create({
        data: {
          ...data,
          databaseName: remotePath, // Connection.databaseName exige valor; sem "banco" real antes de materializar, usa o caminho remoto como rotulo
          sslMode: "disable", // FTP puro; nao se aplica TLS de banco aqui
          encryptedCredentials: encryptSecret(JSON.stringify({ password })),
          metadataJson,
        },
        select: visible,
      }), undefined, 201);
    }
    if (providerRaw === "mssql") {
      const input = mssqlSchema.parse(raw);
      const { password, encrypt, trustServerCert, sshTunnelEnabled, sshHost, sshPort, sshUsername, sshAuthMethod, sshPassword, sshPrivateKey, sshPassphrase, ...data } = input;
      const sslMode = encrypt ? (trustServerCert ? "encrypt-trust" : "encrypt") : (trustServerCert ? "no-encrypt-trust" : "no-encrypt");
      return ok(await prisma.connection.create({
        data: {
          ...data, sslMode,
          encryptedCredentials: encryptSecret(JSON.stringify({ password, encrypt, trustServerCert })),
          ...buildSshTunnelData({ sshTunnelEnabled, sshHost, sshPort, sshUsername, sshAuthMethod, sshPassword, sshPrivateKey, sshPassphrase }),
        },
        select: visible,
      }), undefined, 201);
    }
    const input = postgresSchema.parse(raw);
    const { password, sshTunnelEnabled, sshHost, sshPort, sshUsername, sshAuthMethod, sshPassword, sshPrivateKey, sshPassphrase, ...data } = input;
    return ok(await prisma.connection.create({
      data: {
        ...data,
        encryptedCredentials: encryptSecret(JSON.stringify({ password })),
        ...buildSshTunnelData({ sshTunnelEnabled, sshHost, sshPort, sshUsername, sshAuthMethod, sshPassword, sshPrivateKey, sshPassphrase }),
      },
      select: visible,
    }), undefined, 201);
  } catch (e) {
    return handleApiError(e);
  }
}
