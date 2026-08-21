/**
 * Proteções para o endpoint de queries:
 *  1. Semáforo de concorrência global (máx N queries simultâneas)
 *  2. Cache de resultado em memória com TTL (LRU simples)
 *  3. Rate limit por token/principal (sliding window)
 */

import { createHash } from "crypto";
import { ApiError } from "@/server/http";

// ─────────────────────────────────────────────────────────────────────────────
// Configuração
// ─────────────────────────────────────────────────────────────────────────────

const MAX_CONCURRENT    = 8;          // máx queries simultâneas globais
const CACHE_TTL_MS      = 5 * 60_000; // TTL padrão do cache: 5 minutos
const CACHE_MAX_ENTRIES = 200;        // máx entradas no cache (LRU)
const RATE_WINDOW_MS    = 60_000;     // janela do rate limit: 1 minuto
const RATE_LIMIT_QUERY  = 60;         // req/min por token — /api/v1/queries
const RATE_LIMIT_UPLOAD = 10;         // req/min por token — uploads
const RATE_LIMIT_DEFAULT = 120;       // req/min por token — demais rotas

// ─────────────────────────────────────────────────────────────────────────────
// 1. Semáforo de concorrência
// ─────────────────────────────────────────────────────────────────────────────

let activeQueries = 0;

export function acquireQuerySlot(): void {
  if (activeQueries >= MAX_CONCURRENT) {
    throw new ApiError(
      429,
      "TOO_MANY_CONCURRENT_QUERIES",
      `Servidor ocupado: ${MAX_CONCURRENT} queries em execução. Tente novamente em instantes.`,
    );
  }
  activeQueries++;
}

export function releaseQuerySlot(): void {
  activeQueries = Math.max(0, activeQueries - 1);
}

export function getActiveQueryCount(): number {
  return activeQueries;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Cache de resultado (LRU simples via Map — mantém ordem de inserção)
// ─────────────────────────────────────────────────────────────────────────────

type CacheEntry = {
  result: QueryCacheResult;
  expiresAt: number;
  hits: number;
};

export type QueryCacheResult = {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  executionTimeMs: number;
};

const cache = new Map<string, CacheEntry>();

export function queryCacheKey(
  sql: string,
  datasetId: string | undefined,
  projectId: string | undefined,
  limit: number,
  offset: number,
): string {
  const raw = JSON.stringify({ sql: sql.trim(), datasetId, projectId, limit, offset });
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

export function getCachedResult(key: string): (QueryCacheResult & { cached: true; cacheHits: number }) | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  entry.hits++;
  // Move para o final (LRU touch)
  cache.delete(key);
  cache.set(key, entry);
  return { ...entry.result, cached: true, cacheHits: entry.hits };
}

export function setCachedResult(
  key: string,
  result: QueryCacheResult,
  ttlMs = CACHE_TTL_MS,
): void {
  // Evict entrada mais antiga se atingiu o limite
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { result, expiresAt: Date.now() + ttlMs, hits: 0 });
}

export function invalidateCache(datasetId?: string, projectId?: string): void {
  // Sem índice reverso — se precisar invalidar, limpa tudo ou deixa expirar
  if (!datasetId && !projectId) {
    cache.clear();
    return;
  }
  // Mantém para expirar naturalmente (TTL curto já resolve)
}

export function getCacheStats() {
  const now = Date.now();
  let active = 0;
  for (const entry of cache.values()) {
    if (now <= entry.expiresAt) active++;
  }
  return { totalEntries: cache.size, activeEntries: active };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Rate limit por principal (sliding window em memória)
// ─────────────────────────────────────────────────────────────────────────────

type WindowEntry = { timestamps: number[] };
const rateLimitWindows = new Map<string, WindowEntry>();

// Limpeza periódica de janelas expiradas (evita leak de memória)
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [key, entry] of rateLimitWindows) {
    entry.timestamps = entry.timestamps.filter(t => t > cutoff);
    if (entry.timestamps.length === 0) rateLimitWindows.delete(key);
  }
}, 5 * 60_000).unref();

export type RateLimitTier = "query" | "upload" | "default";

const LIMITS: Record<RateLimitTier, number> = {
  query:   RATE_LIMIT_QUERY,
  upload:  RATE_LIMIT_UPLOAD,
  default: RATE_LIMIT_DEFAULT,
};

export function checkRateLimit(principal: string, tier: RateLimitTier = "default"): void {
  const limit = LIMITS[tier];
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  const key = `${tier}:${principal}`;

  let entry = rateLimitWindows.get(key);
  if (!entry) {
    entry = { timestamps: [] };
    rateLimitWindows.set(key, entry);
  }

  // Remove timestamps fora da janela
  entry.timestamps = entry.timestamps.filter(t => t > cutoff);

  if (entry.timestamps.length >= limit) {
    const retryAfter = Math.ceil((entry.timestamps[0]! + RATE_WINDOW_MS - now) / 1000);
    throw new ApiError(
      429,
      "RATE_LIMIT_EXCEEDED",
      `Limite de ${limit} requisições/min atingido. Tente novamente em ${retryAfter}s.`,
    );
  }

  entry.timestamps.push(now);
}

export function getRateLimitStatus(principal: string, tier: RateLimitTier = "default") {
  const limit = LIMITS[tier];
  const cutoff = Date.now() - RATE_WINDOW_MS;
  const key = `${tier}:${principal}`;
  const entry = rateLimitWindows.get(key);
  const used = entry ? entry.timestamps.filter(t => t > cutoff).length : 0;
  return { limit, used, remaining: Math.max(0, limit - used) };
}
