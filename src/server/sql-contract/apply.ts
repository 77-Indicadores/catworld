/**
 * Aplica o contrato de SQL respeitando o modo (cw_system_settings `sql_contract.mode`):
 *
 *   off     comportamento ANTERIOR ao contrato (regex no storage PG, passthrough no live)
 *   shadow  (padrao) responde como antes, mas roda o motor novo em paralelo e LOGA o que
 *           ele rejeitaria ou traduziria diferente — mede o impacto sem quebrar ninguem
 *   strict  motor novo (AST): rejeita com UNSUPPORTED_CONSTRUCT o que estiver fora do contrato
 *
 * Mudar o modo: UPDATE/INSERT em cw_system_settings (key = 'sql_contract.mode').
 */
import { createHash } from "crypto";
import { prisma } from "@/server/db";
import { TtlCache } from "@/server/cache/ttl-cache";
import { translateMssqlToPg } from "./legacy-translate";
import { translateTsql, mapOutsideLiterals, type ContractTranslation } from "./translate";

export type ContractMode = "off" | "shadow" | "strict";
export type LegacyBehavior = "regex" | "passthrough";

const modeCache = new TtlCache<string, ContractMode>(30_000, 1);

export function invalidateContractModeCache() {
  modeCache.deleteWhere(() => true);
}

export async function getContractMode(): Promise<ContractMode> {
  const hit = modeCache.get("mode");
  if (hit) return hit;
  let mode: ContractMode = "shadow";
  try {
    const rows = await prisma.$queryRawUnsafe<{ value: string }[]>(
      `SELECT value FROM cw_system_settings WHERE key = 'sql_contract.mode' LIMIT 1`,
    );
    const v = rows[0]?.value;
    if (v === "off" || v === "shadow" || v === "strict") mode = v;
  } catch {
    // sem tabela/erro de leitura: mantem o padrao seguro (shadow = comportamento antigo)
  }
  modeCache.set("mode", mode);
  return mode;
}

/**
 * @param path    rotulo do caminho, so para o log (ex: "storage-pg", "live-pg", "derived")
 * @param legacy  o que o caminho fazia ANTES do contrato
 */
export async function contractTranslate(
  input: string,
  target: "mssql" | "postgres",
  path: string,
  legacy: LegacyBehavior,
): Promise<ContractTranslation> {
  if (target === "mssql") return { sql: input.trim(), topLimit: null };

  const mode = await getContractMode();
  if (mode === "strict") return translateTsql(input, "postgres");

  const old: ContractTranslation = legacy === "regex" ? translateMssqlToPg(input) : { sql: input.trim(), topLimit: null };

  if (mode === "shadow") {
    try {
      const next = translateTsql(input, "postgres");
      if (next.sql !== old.sql || next.topLimit !== old.topLimit) log("shadow-diff", path, input);
    } catch (e) {
      log("shadow-reject", path, input, e instanceof Error ? e.message : String(e));
    }
  }
  return old;
}

/** Log sem dados: literais viram '?', SQL truncado, hash para agrupar iguais. */
function log(kind: string, path: string, sql: string, message?: string) {
  const shape = mapOutsideLiterals(sql, (s) => s).replace(/N?'(?:[^']|'')*'/g, "'?'").replace(/\s+/g, " ").trim();
  console.warn(JSON.stringify({
    tag: "sql-contract", kind, path,
    hash: createHash("sha256").update(shape).digest("hex").slice(0, 12),
    shape: shape.slice(0, 300),
    ...(message ? { message: message.split("\n")[0]!.slice(0, 160) } : {}),
  }));
}
