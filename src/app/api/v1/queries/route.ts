import type { NextRequest } from "next/server";
import { z } from "zod";
import * as Sentry from "@sentry/nextjs";
import { resolveActor } from "@/server/auth/actor";
import { syncActorGrants } from "@/server/auth/sync-grants";
import { executeReadOnly, executeReadOnlyStream } from "@/server/azure/sql";
import { ApiError, handleApiError, isQueryTimeout, ok, publicQueryErrorMessage, queryTimeoutError } from "@/server/http";
import { audit } from "@/server/audit";
import { prisma } from "@/server/db";
import { getStorageConnection } from "@/server/storage/connection";
import { pgRoleForActor, runStorageQuery, type QueryResult } from "@/server/sql-contract/run";
import { getContractMode } from "@/server/sql-contract/apply";
import { resolveQueryScope } from "@/server/auth/permissions";
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
      // Contrato de resultado (datas ISO, bigint/decimal string...). Opt-in: o padrao segue o formato anterior.
      normalize: z.boolean().default(false),
    }).parse(await request.json());

    // Acesso: antes esta rota nao conferia nada (no Postgres qualquer ator lia qualquer schema).
    const scope = await resolveQueryScope(actor, { datasetId: input.datasetId, projectId: input.projectId });
    const schemas = scope.datasets.map((d) => d.schemaName);
    const storageServerId = scope.datasets[0]?.storageServerId ?? null;
    const syncScope: { datasetIds?: string[]; projectIds?: string[] } | undefined =
      input.datasetId ? { datasetIds: [input.datasetId] } : input.projectId ? { projectIds: [input.projectId] } : undefined;

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
          ndjsonStream = await executeReadOnlyPgStream(conn as InstanceType<typeof PgStorageConnection>, input.sql, streamTimeout, schemas, input.normalize, await pgRoleForActor(conn, actor, scope.accessible, storageServerId));
        } else {
          ndjsonStream = await executeReadOnlyStream(actor.principal, input.sql, streamTimeout, schemas, storageServerId, input.normalize);
        }
        return new Response(ndjsonStream, {
          headers: { "Content-Type": "application/x-ndjson", "X-Cache": "MISS" },
        });
      } finally {
        releaseQuerySlot();
      }
    }

    // Cache: verifica antes de executar
    // Versao dos dados do escopo: upload/sync/derivada gravam last_data_at, entao o cache nao serve dado velho.
    const versionIds = (scope.datasets.length ? scope.datasets : scope.accessible).map((d) => d.id);
    const agg = await prisma.datasetTable.aggregate({
      where: { datasetId: { in: versionIds } },
      _max: { lastDataAt: true, updatedAt: true },
      _count: { _all: true },
    });
    const dataVersion = `${agg._count._all}:${agg._max.lastDataAt?.getTime() ?? 0}:${agg._max.updatedAt?.getTime() ?? 0}`;
    const cacheKey = queryCacheKey(input.sql, input.datasetId, input.projectId, input.limit, input.offset, actor.principal, storageServerId, input.normalize, dataVersion, await getContractMode());
    // O executor limita o tempo de consultas paginadas a 120s (so o stream vai ate 300s): avisa em vez de calar.
    const warnings = input.timeout > 120 ? [`timeout limitado a 120s nesta rota (informado: ${input.timeout}s); "stream": true aceita ate 300s`] : [];
    const cached = getCachedResult(cacheKey);
    if (cached) {
      // Campos de cache ficam em meta/cabecalhos, nao dentro de data (o MISS nao os tem: mesma forma de data nos dois).
      const res = ok(cached.result, { cached: true, cacheHits: cached.hits, ...(warnings.length ? { warnings } : {}) });
      res.headers.set("X-Cache", "HIT");
      res.headers.set("X-Cache-Hits", String(cached.hits));
      return res;
    }

    // Semáforo: limita concorrência global
    acquireQuerySlot();

    let result: QueryResult;

    try {
      // Roteia pelo provider do storage do dataset (contrato de SQL unico)
      result = await runStorageQuery({
        actor, accessible: scope.accessible, sql: input.sql, timeout: input.timeout,
        limit: input.limit, offset: input.offset, schemas, storageServerId, normalize: input.normalize,
      });
    } finally {
      releaseQuerySlot();
    }

    // Salva no cache (só queries que retornaram sem erro)
    setCachedResult(cacheKey, result);

    await audit(actor, "QUERY_EXECUTED", "query", undefined, {
      rowCount: result.rowCount,
      executionTimeMs: result.executionTimeMs,
    });
    const res = ok(result, warnings.length ? { warnings } : undefined);
    res.headers.set("X-Cache", "MISS");
    return res;
  } catch (e) {
    // ApiError já carrega o status/code corretos (ex: 413 RESULT_TOO_LARGE,
    // 404 NOT_FOUND) — não reembalar como QUERY_FAILED genérico. ApiError
    // também tem uma propriedade "code", então o `"code" in e` abaixo
    // (pensado pra erros do driver SQL) capturava ApiError por engano e
    // trocava o status real por 400 antes de chegar no cliente.
    if (e instanceof ApiError) return handleApiError(e);
    if (e instanceof Error && "code" in e) {
      Sentry.captureException(e);
      if (isQueryTimeout(e)) return handleApiError(queryTimeoutError());
      return handleApiError(new ApiError(400, "QUERY_FAILED", publicQueryErrorMessage(e.message)));
    }
    return handleApiError(e);
  }
}
