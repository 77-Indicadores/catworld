import type { NextRequest } from "next/server";
import sql from "mssql";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { handleApiError, ok, ApiError } from "@/server/http";
import { decryptSecret } from "@/server/security/crypto";

function parseMssqlUrl(url: string): sql.config {
  const withoutScheme = url.replace(/^sqlserver:\/\//i, "");
  const [hostPort, ...rest] = withoutScheme.split(";").filter(Boolean);
  const [server, port] = (hostPort ?? "").split(":");
  const params = Object.fromEntries(
    rest.map((part) => { const i = part.indexOf("="); return [part.slice(0, i).toLowerCase(), part.slice(i + 1)]; }),
  );
  return {
    server: server ?? "",
    port: port ? Number(port) : 1433,
    database: params.database,
    user: params.user,
    password: params.password,
    options: {
      encrypt: params.encrypt !== "false",
      trustServerCertificate: params.trustservercertificate === "true",
    },
    connectionTimeout: 15_000,
    requestTimeout: 10_000,
  };
}

export async function POST(r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(r);
    requireRole(actor, ["ADMIN"]);
    const id = (await params).id;

    const record = await prisma.storageServer.findUnique({ where: { id }, select: { url: true, encryptedCredentials: true } });
    if (!record) throw new ApiError(404, "NOT_FOUND", "StorageServer não encontrado");

    let resolvedUrl: string | null = null;
    if (record.encryptedCredentials) {
      try { resolvedUrl = decryptSecret(record.encryptedCredentials); } catch { /* fallback */ }
    }
    if (!resolvedUrl) resolvedUrl = record.url;
    if (!resolvedUrl) throw new ApiError(400, "NO_URL", "StorageServer sem URL configurada");

    const started = Date.now();
    const pool = new sql.ConnectionPool(parseMssqlUrl(resolvedUrl));
    try {
      await pool.connect();
      const result = await pool.request().query<{ db: string }>("SELECT DB_NAME() AS db");
      const latencyMs = Date.now() - started;
      const database = result.recordset[0]?.db ?? "";

      await prisma.storageServer.update({
        where: { id },
        data: { lastStatus: "healthy", lastLatencyMs: latencyMs, lastCheckedAt: new Date() },
      });

      return ok({ healthy: true, latencyMs, database });
    } catch (err) {
      await prisma.storageServer.update({
        where: { id },
        data: { lastStatus: "error", lastCheckedAt: new Date() },
      }).catch(() => undefined);
      throw err;
    } finally {
      await pool.close().catch(() => undefined);
    }
  } catch (e) {
    return handleApiError(e);
  }
}
