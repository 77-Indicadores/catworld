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
const RATE_LIMIT_UPLOAD = 60;         // req/min por token — criacao de uploads
// Protecao contra loop descontrolado, nao contra uso legitimo: SDK paginando tabelas grandes faz dezenas de
// requisicoes por segundo. (OData fica fora: o Power BI pagina muito e rapido.)
const RATE_LIMIT_DEFAULT = 2400;      // req/min por principal — demais rotas

// O limite de linhas (10.000) não protege contra colunas muito largas
// (NVARCHAR(MAX)/TEXT sem teto de tamanho) — um resultado "dentro do limite
// de linhas" ainda pode ser grande o bastante pra estourar memória na hora de
// ler/serializar. Este teto é aplicado incrementalmente, linha a linha,
// DURANTE a leitura do driver (ver executeReadOnly em server/azure/sql.ts,
// que cancela a query no meio quando estoura) — não depois de já ter
// materializado o resultado inteiro, que seria tarde demais pra evitar o OOM.
export const MAX_RESULT_BYTES = 50 * 1024 * 1024; // ~50MB

/** Soma incremental de tamanho aproximado (bytes) de uma linha já serializada. */
export function approxRowBytes(row: Record<string, unknown>): number {
  return JSON.stringify(row).length;
}

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
  bytes: number;
};

export type QueryCacheResult = {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  executionTimeMs: number;
};

const cache = new Map<string, CacheEntry>();
let cacheBytes = 0;

// Orcamento em BYTES (antes so havia teto de 200 entradas, cada uma de ate 50MB): resultado grande nao e cacheado.
const CACHE_MAX_BYTES = 64 * 1024 * 1024;      // total
const CACHE_MAX_ENTRY_BYTES = 2 * 1024 * 1024; // por entrada

/** Estimativa barata do tamanho serializado (amostra de ate 50 linhas). */
export function estimateResultBytes(r: QueryCacheResult): number {
  const n = r.rows.length;
  if (n === 0) return 200;
  const sample = r.rows.slice(0, Math.min(50, n));
  const per = sample.reduce((acc, row) => acc + approxRowBytes(row), 0) / sample.length;
  return Math.ceil(per * n) + r.columns.join("").length + 200;
}

function dropEntry(key: string): void {
  const e = cache.get(key);
  if (!e) return;
  cacheBytes -= e.bytes;
  cache.delete(key);
}

/**
 * Chave do cache. `dataVersion` (max de last_data_at/updated_at + n. de tabelas dos datasets do escopo) faz o cache
 * "mudar de endereco" quando um upload, sync ou derivada grava dados novos — antes o resultado velho vivia ate 5 min.
 * `contractMode` evita servir, apos trocar o modo do contrato, um resultado gerado pelo outro modo.
 */
export function queryCacheKey(
  sql: string,
  datasetId: string | undefined,
  projectId: string | undefined,
  limit: number,
  offset: number,
  // Resultado depende de quem pergunta (grants no MSSQL) e de onde o dado mora
  principal: string,
  storageServerId: string | null,
  normalize = false,
  dataVersion = "",
  contractMode = "",
): string {
  const raw = JSON.stringify({ sql: sql.trim(), datasetId, projectId, limit, offset, principal, storageServerId, normalize, dataVersion, contractMode });
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

export function getCachedResult(key: string): { result: QueryCacheResult; hits: number } | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    dropEntry(key);
    return null;
  }
  entry.hits++;
  // Move para o final (LRU touch)
  cache.delete(key);
  cache.set(key, entry);
  return { result: entry.result, hits: entry.hits };
}

export function setCachedResult(
  key: string,
  result: QueryCacheResult,
  ttlMs = CACHE_TTL_MS,
): void {
  const bytes = estimateResultBytes(result);
  if (bytes > CACHE_MAX_ENTRY_BYTES) return; // grande demais para valer a pena guardar
  dropEntry(key);
  // Libera os mais antigos ate caber (por entradas E por bytes)
  while (cache.size > 0 && (cache.size >= CACHE_MAX_ENTRIES || cacheBytes + bytes > CACHE_MAX_BYTES)) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    dropEntry(oldest);
  }
  cache.set(key, { result, expiresAt: Date.now() + ttlMs, hits: 0, bytes });
  cacheBytes += bytes;
}

export function invalidateCache(): void {
  cache.clear();
  cacheBytes = 0;
}

export function getCacheStats() {
  const now = Date.now();
  let active = 0;
  for (const entry of cache.values()) {
    if (now <= entry.expiresAt) active++;
  }
  return { totalEntries: cache.size, activeEntries: active, bytes: cacheBytes };
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
      { retryAfterSeconds: retryAfter, limit, tier },
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
