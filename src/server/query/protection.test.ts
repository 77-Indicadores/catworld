import { beforeEach, describe, expect, it } from "vitest";
import {
  estimateResultBytes, getCacheStats, getCachedResult, invalidateCache, queryCacheKey, setCachedResult,
  type QueryCacheResult,
} from "./protection";

const result = (rows: number, width = 10): QueryCacheResult => ({
  columns: ["a"],
  rows: Array.from({ length: rows }, (_, i) => ({ a: "x".repeat(width) + i })),
  rowCount: rows,
  truncated: false,
  executionTimeMs: 1,
});

const key = (over: Partial<{ sql: string; version: string; mode: string; principal: string }> = {}) =>
  queryCacheKey(over.sql ?? "SELECT 1", "d1", undefined, 100, 0, over.principal ?? "p1", null, false, over.version ?? "v1", over.mode ?? "fallback");

beforeEach(() => invalidateCache());

describe("chave do cache", () => {
  it("muda com a VERSAO DOS DADOS (upload/sync/derivada) — nao serve resultado velho", () => {
    expect(key({ version: "3:100:100" })).not.toBe(key({ version: "3:200:200" }));
  });
  it("muda com o modo do contrato, o principal e o SQL", () => {
    expect(key({ mode: "fallback" })).not.toBe(key({ mode: "strict" }));
    expect(key({ principal: "a" })).not.toBe(key({ principal: "b" }));
    expect(key({ sql: "SELECT 1" })).not.toBe(key({ sql: "SELECT 2" }));
  });
  it("e estavel para a mesma entrada (ignora espacos nas pontas do SQL)", () => {
    expect(key({ sql: "SELECT 1" })).toBe(key({ sql: "  SELECT 1  " }));
  });
});

describe("cache: HIT/MISS e limites", () => {
  it("HIT devolve o resultado como foi guardado (sem campos de cache dentro dele) e conta acertos", () => {
    const k = key();
    setCachedResult(k, result(3));
    const first = getCachedResult(k)!;
    expect(first.hits).toBe(1);
    expect(Object.keys(first.result).sort()).toEqual(["columns", "executionTimeMs", "rowCount", "rows", "truncated"]);
    expect(getCachedResult(k)!.hits).toBe(2);
    expect(getCachedResult(key({ sql: "outra" }))).toBeNull();
  });

  it("resultado grande demais (> 2MB) nao e cacheado", () => {
    const big = result(2000, 2000); // ~4MB
    expect(estimateResultBytes(big)).toBeGreaterThan(2 * 1024 * 1024);
    setCachedResult(key({ sql: "grande" }), big);
    expect(getCachedResult(key({ sql: "grande" }))).toBeNull();
    expect(getCacheStats().bytes).toBe(0);
  });

  it("orcamento total em bytes: entradas antigas saem para caber as novas", () => {
    // ~1MB cada; o teto total e 64MB
    for (let i = 0; i < 90; i++) setCachedResult(key({ sql: `q${i}` }), result(1000, 1000));
    const st = getCacheStats();
    expect(st.bytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(st.totalEntries).toBeLessThan(90);
    expect(getCachedResult(key({ sql: "q0" }))).toBeNull();      // a mais antiga saiu
    expect(getCachedResult(key({ sql: "q89" }))).not.toBeNull(); // a mais nova ficou
  });

  it("sobrescrever a mesma chave nao infla a contagem de bytes", () => {
    const k = key();
    setCachedResult(k, result(100));
    const one = getCacheStats().bytes;
    setCachedResult(k, result(100));
    expect(getCacheStats().bytes).toBe(one);
  });

  it("invalidateCache zera entradas e bytes", () => {
    setCachedResult(key(), result(10));
    invalidateCache();
    expect(getCacheStats()).toMatchObject({ totalEntries: 0, bytes: 0 });
  });
});
