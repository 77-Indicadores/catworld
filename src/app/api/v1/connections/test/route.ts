import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { decryptSecret, encryptSecret } from "@/server/security/crypto";
import { handleApiError, ok } from "@/server/http";
import { testPostgres } from "@/server/connections/postgres";
import { testMssql } from "@/server/connections/mssql";
import { statRemoteFile } from "@/server/connections/ftp-watch";

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

/**
 * "Testar" firebird-ftp ANTES de salvar não pode fazer o download+gbak completo (minutos, e nem há
 * `connectionId` ainda para materializar contra); aqui só confirmamos que o FTP está alcançável e que o
 * arquivo esperado existe (`statRemoteFile`: só LIST, nunca baixa) — o "teste de verdade" (materializar e
 * abrir com o driver Firebird) acontece em POST /api/v1/connections/[id]/test, depois de salva.
 */
const firebirdFtpSchema = z.object({
  provider: z.literal("firebird-ftp"),
  server: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535).default(21),
  username: z.string().min(1),
  password: z.string().min(1),
  remotePath: z.string().min(1),
  filePattern: z.string().min(1),
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
        databaseName: z.string().min(1).optional(),
        username: z.string().min(1),
        // mssql-specific TLS overrides (optional — fall back to stored sslMode)
        encrypt: z.boolean().optional(),
        trustServerCert: z.boolean().optional(),
        // firebird-ftp: nao envia senha nova, mas o formulario pode ter mudado o caminho/padrao remoto
        remotePath: z.string().min(1).optional(),
        filePattern: z.string().min(1).optional(),
      }).merge(sshTunnelSchema);
      const edit = editSchema.parse(raw);
      const existing = await prisma.connection.findUniqueOrThrow({
        where: { id: edit.connectionId },
        select: { encryptedCredentials: true, provider: true, sslMode: true, metadataJson: true, sshTunnelEnabled: true, sshHost: true, sshPort: true, sshUsername: true, sshAuthMethod: true, sshEncryptedSecret: true },
      });
      if (existing.provider === "firebird-ftp") {
        // Ver nota acima: teste (mesmo no modo edicao) so confere alcancabilidade do FTP, nunca materializa.
        const existingConfig = firebirdFtpSchema.pick({ remotePath: true, filePattern: true }).partial().safeParse(
          existing.metadataJson ? { remotePath: JSON.parse(existing.metadataJson)?.ftp?.remotePath, filePattern: JSON.parse(existing.metadataJson)?.ftp?.filePattern } : {},
        );
        const remotePath = edit.remotePath ?? existingConfig.data?.remotePath;
        const filePattern = edit.filePattern ?? existingConfig.data?.filePattern;
        if (!remotePath || !filePattern) throw new Error("Conexao firebird-ftp sem remotePath/filePattern configurados");
        const { password } = JSON.parse(decryptSecret(existing.encryptedCredentials)) as { password: string };
        const started = Date.now();
        const stat = await statRemoteFile({ host: edit.server, port: edit.port, user: edit.username, password }, remotePath, filePattern);
        if (!stat) throw new Error(`Nenhum arquivo bate "${filePattern}" em ${remotePath}`);
        return ok({ healthy: true, latencyMs: Date.now() - started, remoteFile: { name: stat.name, size: stat.size, mtime: stat.mtime } });
      }
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
        ...edit, databaseName: edit.databaseName ?? "", provider: existing.provider, sslMode, encryptedCredentials: existing.encryptedCredentials,
        ...(sshOverride ?? { sshTunnelEnabled: existing.sshTunnelEnabled, sshHost: existing.sshHost, sshPort: existing.sshPort, sshUsername: existing.sshUsername, sshAuthMethod: existing.sshAuthMethod, sshEncryptedSecret: existing.sshEncryptedSecret }),
      };
      const result = existing.provider === "mssql" ? await testMssql(conn) : await testPostgres(conn);
      return ok({ healthy: true, ...result });
    }

    if (providerRaw === "firebird-ftp") {
      const input = firebirdFtpSchema.parse(raw);
      const started = Date.now();
      const stat = await statRemoteFile({ host: input.server, port: input.port, user: input.username, password: input.password }, input.remotePath, input.filePattern);
      if (!stat) throw new Error(`Nenhum arquivo bate "${input.filePattern}" em ${input.remotePath}`);
      return ok({ healthy: true, latencyMs: Date.now() - started, remoteFile: { name: stat.name, size: stat.size, mtime: stat.mtime } });
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
