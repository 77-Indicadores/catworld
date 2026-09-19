/**
 * Formato de resultado PADRAO (quando a requisicao nao manda `normalize`).
 *   legacy     (padrao atual)  tipos como o driver entrega — DEPRECADO
 *   normalized                 datas ISO, decimal/bigint como string... (ver sql-contract/result.ts) — RECOMENDADO
 * O admin migra sem deploy: PATCH /settings/sql-contract { "resultFormat": "normalized" }. Quem manda `normalize`
 * explicitamente nunca e afetado. Chave: cw_system_settings `result.normalize_default`.
 */
import { prisma } from "@/server/db";
import { TtlCache } from "@/server/cache/ttl-cache";

const cache = new TtlCache<string, boolean>(30_000, 1);

export async function getNormalizeDefault(): Promise<boolean> {
  const hit = cache.get("v");
  if (hit !== null) return hit;
  let v = false;
  try {
    const rows = await prisma.$queryRawUnsafe<{ value: string }[]>(
      `SELECT value FROM cw_system_settings WHERE key = 'result.normalize_default' LIMIT 1`,
    );
    v = rows[0]?.value === "true";
  } catch {
    // sem tabela/erro de leitura: mantem o formato legado (compativel)
  }
  cache.set("v", v);
  return v;
}

export function invalidateNormalizeDefaultCache() {
  cache.deleteWhere(() => true);
}
