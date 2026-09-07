/**
 * Cache de páginas do endpoint OData — extraído de app/api/odata/[...path]/route.ts
 * porque route.ts do App Router só pode exportar handlers HTTP (GET/POST/...) e
 * algumas poucas constantes especiais; qualquer outro export quebra o typecheck
 * do Next ("does not satisfy the constraint '{ [x: string]: never; }'").
 *
 * Reduz carga no banco para consultas repetitivas (ex: Power BI, SDK paginando
 * mesmas páginas). TTL curto (30s) garante que dados publicados aparecem rápido.
 * Chave inclui top/skip/select — páginas diferentes nunca colidem.
 */
import { TtlCache } from "./ttl-cache";

const PAGE_CACHE_TTL = 30_000; // 30 s
const PAGE_CACHE_MAX = 200;    // entradas máximas

const pageCache = new TtlCache<string, Record<string, unknown>>(PAGE_CACHE_TTL, PAGE_CACHE_MAX);

export function getPageCache(key: string): Record<string, unknown> | null {
  return pageCache.get(key);
}

export function setPageCache(key: string, response: Record<string, unknown>) {
  pageCache.set(key, response);
}

/** Invalida todas as entradas de cache de uma tabela específica (chamar após upload/sync). */
export function invalidateODataPageCache(projectSlug: string, datasetSlug: string, tableSqlName?: string) {
  const prefix = `${projectSlug}/${datasetSlug}/${tableSqlName ?? ""}`;
  pageCache.deleteWhere((key) => key.startsWith(prefix));
}
