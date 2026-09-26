import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { encryptSecret, decryptSecret } from "@/server/security/crypto";
import { handleApiError, ok } from "@/server/http";
import { parseFirebirdFtpConfig } from "@/server/connections/sources";

const visible = { id: true, name: true, provider: true, environment: true, server: true, port: true, databaseName: true, sslMode: true, username: true, active: true, sshTunnelEnabled: true, sshHost: true, sshPort: true, sshUsername: true, sshAuthMethod: true, metadataJson: true, lastStatus: true, lastLatencyMs: true, lastCheckedAt: true, createdAt: true, updatedAt: true } as const;

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
      sshTunnelEnabled: z.boolean().optional(),
      sshHost: z.string().min(1).optional(),
      sshPort: z.coerce.number().int().min(1).max(65535).optional(),
      sshUsername: z.string().min(1).optional(),
      sshAuthMethod: z.enum(["password", "privateKey"]).optional(),
      sshPassword: z.string().optional(),
      sshPrivateKey: z.string().optional(),
      sshPassphrase: z.string().optional(),
      // firebird-ftp: nao tem databaseName/sslMode reais (ver POST) — so o caminho/padrao do FTP e do backup
      // dentro do ZIP, guardados em metadataJson.
      remotePath: z.string().min(1).optional(),
      filePattern: z.string().min(1).optional(),
      innerFilePattern: z.string().min(1).optional(),
      charset: z.string().min(1).optional(),
      pollMinutes: z.coerce.number().int().min(1).max(10080).optional(),
    }).parse(await request.json());
    const { password, encrypt, trustServerCert, sshTunnelEnabled, sshHost, sshPort, sshUsername, sshAuthMethod, sshPassword, sshPrivateKey, sshPassphrase, remotePath, filePattern, innerFilePattern, charset, pollMinutes, ...data } = input;
    let credentialsUpdate: { encryptedCredentials?: string } = {};
    if (password || encrypt !== undefined || trustServerCert !== undefined) {
      const existing = await prisma.connection.findUniqueOrThrow({ where: { id }, select: { encryptedCredentials: true } });
      const current = JSON.parse(decryptSecret(existing.encryptedCredentials)) as Record<string, unknown>;
      if (password) current.password = password;
      if (encrypt !== undefined) current.encrypt = encrypt;
      if (trustServerCert !== undefined) current.trustServerCert = trustServerCert;
      credentialsUpdate = { encryptedCredentials: encryptSecret(JSON.stringify(current)) };
    }
    let metadataUpdate: { metadataJson?: string } = {};
    if (remotePath !== undefined || filePattern !== undefined || innerFilePattern !== undefined || charset !== undefined || pollMinutes !== undefined) {
      const existing = await prisma.connection.findUniqueOrThrow({ where: { id }, select: { metadataJson: true, server: true, port: true } });
      const current = existing.metadataJson ? parseFirebirdFtpConfig(existing.metadataJson) : undefined;
      const nextInnerFilePattern = innerFilePattern ?? current?.firebird?.innerFilePattern;
      const nextCharset = charset ?? current?.firebird?.charset;
      metadataUpdate = {
        metadataJson: JSON.stringify(parseFirebirdFtpConfig(JSON.stringify({
          ftp: {
            host: data.server ?? existing.server,
            port: data.port ?? existing.port ?? undefined,
            remotePath: remotePath ?? current?.ftp.remotePath,
            filePattern: filePattern ?? current?.ftp.filePattern,
            pollMinutes: pollMinutes ?? current?.ftp.pollMinutes,
          },
          firebird: (nextInnerFilePattern || nextCharset) ? { innerFilePattern: nextInnerFilePattern, charset: nextCharset } : undefined,
        }))),
      };
      // Connection.databaseName exige valor e dobra de rotulo pra firebird-ftp (POST usa remotePath — ver
      // route.ts); sem isto, editar o caminho remoto deixaria o card mostrando o caminho antigo.
      if (remotePath !== undefined) data.databaseName = remotePath;
    }
    let sshUpdate: Record<string, unknown> = {};
    if (sshTunnelEnabled === false) {
      sshUpdate = { sshTunnelEnabled: false, sshHost: null, sshPort: null, sshUsername: null, sshAuthMethod: null, sshEncryptedSecret: null };
    } else if (sshTunnelEnabled === true || sshHost || sshUsername || sshAuthMethod || sshPassword || sshPrivateKey) {
      if (!sshHost || !sshUsername || !sshAuthMethod) throw new Error("Tunel SSH exige host, usuario e metodo de autenticacao");
      const secret = sshAuthMethod === "password" ? { password: sshPassword } : { privateKey: sshPrivateKey, passphrase: sshPassphrase };
      sshUpdate = {
        sshTunnelEnabled: true,
        sshHost, sshPort: sshPort ?? 22, sshUsername, sshAuthMethod,
        sshEncryptedSecret: encryptSecret(JSON.stringify(secret)),
      };
    }
    return ok(await prisma.connection.update({
      where: { id },
      data: { ...data, ...credentialsUpdate, ...metadataUpdate, ...sshUpdate },
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
