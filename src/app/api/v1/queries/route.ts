import type { NextRequest } from "next/server";
import { z } from "zod";
import * as Sentry from "@sentry/nextjs";
import { resolveActor } from "@/server/auth/actor";
import { syncActorGrants } from "@/server/auth/sync-grants";
import { executeReadOnly, executeReadOnlyStream } from "@/server/azure/sql";
import { ApiError, handleApiError, ok } from "@/server/http";
import { audit } from "@/server/audit";
import { prisma } from "@/server/db";
import { getStorageConnection } from "@/server/storage/connection";
import {
  acquireQuerySlot,
  releaseQuerySlot,
  checkRateLimit,
  queryCacheKey,
  getCachedResult,
  setCachedResult,
} from "@/server/query/protection";

export async function POST(request: NextRequest) {
  try {
    const actor = await resolveActor(request);

    // Rate limit: 60 req/min por token
    checkRateLimit(actor.principal, "query");

    const input = z.object({
      sql: z.string().min(1).max(50000),
      timeout: z.number().int().min(1).max(300).default(60),
      limit: z.number().int().min(1).max(10000).default(10000),
      offset: z.number().int().min(0).default(0),
      datasetId: z.string().uuid().optional(),
      projectId: z.string().uuid().optional(),
      stream: z.boolean().default(false),
    }).parse(await request.json());

    let schemas: string[] = [];
    let storageServerId: string | null = null;
    let syncScope: { datasetIds?: string[]; projectIds?: string[] } | undefined;

    if (input.datasetId) {
      const dataset = await prisma.dataset.findUnique({
        where: { id: input.datasetId, active: true },
        select: { schemaName: true, storageServerId: true, id: true },
      });
      if (!dataset) throw new ApiError(404, "NOT_FOUND", "Dataset nao encontrado");
      schemas = [dataset.schemaName];
      storageServerId = dataset.storageServerId;
      syncScope = { datasetIds: [dataset.id] };
    } else if (input.projectId) {
      const datasets = await prisma.dataset.findMany({
        where: { projectId: input.projectId, active: true },
        select: { schemaName: true, storageServerId: true },
      });
      if (!datasets.length) throw new ApiError(404, "NOT_FOUND", "Nenhum dataset encontrado para este projeto");
      schemas = datasets.map((d) => d.schemaName);
      // Para projectId, todos os datasets devem estar no mesmo storage; usa o primeiro
      storageServerId = datasets[0]?.storageServerId ?? null;
      syncScope = { projectIds: [input.projectId] };
    }

    await syncActorGrants(actor, syncScope);

    // ── Modo streaming (sem limite de linhas, 1 request, NDJSON) ─────────────
    if (input.stream) {
      acquireQuerySlot();
      const streamTimeout = 300; // streaming sempre usa o máximo — sem paginação, sem timeout curto
      try {
        const conn = await getStorageConnection(storageServerId);
        let ndjsonStream: ReadableStream<Uint8Array>;
        if (conn.provider === "postgres") {
          const { executeReadOnlyPgStream } = await import("@/server/storage/pg-query");
          const { PgStorageConnection } = await import("@/server/storage/pg-storage");
          ndjsonStream = await executeReadOnlyPgStream(conn as InstanceType<typeof PgStorageConnection>, input.sql, streamTimeout, schemas);
        } else {
          ndjsonStream = await executeReadOnlyStream(actor.principal, input.sql, streamTimeout, schemas, storageServerId);
        }
        return new Response(ndjsonStream, {
          headers: { "Content-Type": "application/x-ndjson", "X-Cache": "MISS" },
        });
      } finally {
        releaseQuerySlot();
      }
    }

    // Cache: verifica antes de executar
    const cacheKey = queryCacheKey(input.sql, input.datasetId, input.projectId, input.limit, input.offset);
    const cached = getCachedResult(cacheKey);
    if (cached) {
      const res = ok(cached);
      res.headers.set("X-Cache", "HIT");
      res.headers.set("X-Cache-Hits", String(cached.cacheHits));
      return res;
    }

    // Semáforo: limita concorrência global
    acquireQuerySlot();

    let result: Awaited<ReturnType<typeof executeReadOnly>>;

    try {
      // Roteia pelo provider do storage do dataset
      const conn = await getStorageConnection(storageServerId);

      if (conn.provider === "postgres") {
        const { executeReadOnlyPg } = await import("@/server/storage/pg-query");
        const { PgStorageConnection } = await import("@/server/storage/pg-storage");
        result = await executeReadOnlyPg(
          conn as InstanceType<typeof PgStorageConnection>,
          input.sql,
          input.timeout,
          input.limit,
          schemas,
          input.offset,
        );
      } else {
        result = await executeReadOnly(
          actor.principal,
          input.sql,
          input.timeout,
          input.limit,
          schemas,
          input.offset,
          120,
          storageServerId,
        );
      }
    } finally {
      releaseQuerySlot();
    }

    // Salva no cache (só queries que retornaram sem erro)
    setCachedResult(cacheKey, result);

    await audit(actor, "QUERY_EXECUTED", "query", undefined, {
      rowCount: result.rowCount,
      executionTimeMs: result.executionTimeMs,
    });
    const res = ok(result);
    res.headers.set("X-Cache", "MISS");
    return res;
  } catch (e) {
    if (e instanceof Error && "code" in e) {
      Sentry.captureException(e);
      return handleApiError(new ApiError(400, "QUERY_FAILED", e.message));
    }
    return handleApiError(e);
  }
}
