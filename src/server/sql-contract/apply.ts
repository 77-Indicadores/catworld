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
import { legacyGate, legacyWarning, attachWarnings } from "./fallback-gate";
import { translateTsql, mapOutsideLiterals, SqlContractError, type ContractTranslation } from "./translate";

export type ContractMode = "off" | "shadow" | "fallback" | "strict";
export type LegacyBehavior = "regex" | "passthrough";

const modeCache = new TtlCache<string, ContractMode>(30_000, 1);

export function invalidateContractModeCache() {
  modeCache.deleteWhere(() => true);
}

export async function getContractMode(): Promise<ContractMode> {
  const hit = modeCache.get("mode");
  if (hit) return hit;
  let mode: ContractMode = "fallback";
  try {
    const rows = await prisma.$queryRawUnsafe<{ value: string }[]>(
      `SELECT value FROM cw_system_settings WHERE key = 'sql_contract.mode' LIMIT 1`,
    );
    const v = rows[0]?.value;
    if (v === "off" || v === "shadow" || v === "fallback" || v === "strict") mode = v;
  } catch {
    // sem tabela/erro de leitura: usa o padrao (fallback = motor novo com rede de seguranca do antigo)
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
  countTranslated(path);

  const mode = await getContractMode();
  if (mode === "strict") return translateTsql(input, "postgres");

  const old = legacyTranslation(input, legacy);

  if (mode === "fallback") {
    try {
      return translateTsql(input, "postgres");
    } catch (e) {
      if (!(e instanceof SqlContractError)) throw e;
      log("fallback-reject", path, input, e.message);
      return legacyOrThrow(input, e, old, path);
    }
  }

  if (mode === "shadow") {
    try {
      const next = translateTsql(input, "postgres");
      if (canon(next.sql) !== canon(old.sql) || next.topLimit !== old.topLimit) log("shadow-diff", path, input);
    } catch (e) {
      log("shadow-reject", path, input, e instanceof Error ? e.message : String(e));
    }
  }
  return old;
}

/**
 * ENT-04: o legado so e usado quando NAO muda o resultado de forma conhecida (legacyGate). Caso contrario o erro do motor novo
 * (UNSUPPORTED_CONSTRUCT) sobe com o motivo. Quando o legado e usado, a traducao leva um aviso LEGACY_TRANSLATION.
 */
function legacyOrThrow(input: string, e: SqlContractError, old: ContractTranslation, path: string): ContractTranslation {
  const gate = legacyGate(input);
  if (gate.block) {
    log("fallback-blocked", path, input, gate.block);
    throw new SqlContractError(`${e.message} O tradutor antigo nao foi usado como alternativa porque mudaria o resultado: ${gate.block}.`, (e as { details?: unknown }).details);
  }
  return { ...old, warnings: [legacyWarning(e.message, gate)] };
}

function legacyTranslation(input: string, legacy: LegacyBehavior): ContractTranslation {
  return legacy === "regex" ? translateMssqlToPg(input) : { sql: input.trim(), topLimit: null };
}

/** Erro do BANCO ao executar a query (sintaxe/funcao/coluna...), nao timeout nem erro da aplicacao. */
function isDbQueryError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const err = e as Error & { code?: unknown; details?: { postgresCode?: string } };
  const pgCode = typeof err.code === "string" && /^[0-9A-Z]{5}$/.test(err.code) ? err.code : err.details?.postgresCode;
  if (pgCode) return pgCode !== "57014" && pgCode !== "57P01"; // statement_timeout / cancelamento: nao repete
  return err.code === "POSTGRES_QUERY_FAILED";
}

/**
 * Executa com a rede de seguranca do modo `fallback`:
 *   1) SQL traduzido pelo motor novo; se ele REJEITA, usa o caminho antigo;
 *   2) se o banco FALHAR ao executar o SQL novo, refaz com o antigo; se o antigo tambem falhar,
 *      propaga o erro do antigo (= comportamento anterior ao contrato).
 * Nos outros modos, apenas traduz (contractTranslate) e executa uma vez.
 */
export async function runWithContract<T>(
  input: string,
  target: "mssql" | "postgres",
  path: string,
  legacy: LegacyBehavior,
  exec: (t: ContractTranslation) => Promise<T>,
): Promise<T> {
  if (target === "mssql") return exec({ sql: input.trim(), topLimit: null });
  const mode = await getContractMode();
  if (mode !== "fallback") return exec(await contractTranslate(input, target, path, legacy));
  countTranslated(path);

  const old = legacyTranslation(input, legacy);
  let next: ContractTranslation;
  try {
    next = translateTsql(input, "postgres");
  } catch (e) {
    if (!(e instanceof SqlContractError)) throw e;
    log("fallback-reject", path, input, e.message);
    const legacyT = legacyOrThrow(input, e, old, path);
    return attachWarnings(await exec(legacyT), legacyT.warnings);
  }
  try {
    return await exec(next);
  } catch (e) {
    if (!isDbQueryError(e) || (canon(next.sql) === canon(old.sql) && next.topLimit === old.topLimit)) throw e;
    const gate = legacyGate(input);
    if (gate.block) {
      log("fallback-blocked", path, input, gate.block);
      throw e; // o erro do banco do SQL novo (traducao fiel) sobe; o legado mudaria o resultado
    }
    log("fallback-exec", path, input, e instanceof Error ? e.message : String(e));
    // se o antigo tambem falhar, sobe o erro do antigo
    return attachWarnings(await exec(old), [legacyWarning(`erro do banco: ${e instanceof Error ? e.message : String(e)}`, gate)]);
  }
}

/** Forma canonica so para comparar: o gerador acrescenta ASC e reformata espacos/caixa sem mudar o sentido. */
const canon = (sql: string) => sql.replace(/\s+ASC\b/gi, "").replace(/\s+/g, "").toLowerCase();

/** Log sem dados: literais viram '?', SQL truncado, hash para agrupar iguais. */
function log(kind: string, path: string, sql: string, message?: string) {
  const shape = mapOutsideLiterals(sql, (s) => s).replace(/N?'(?:[^']|'')*'/g, "'?'").replace(/\s+/g, " ").trim();
  const hash = createHash("sha256").update(shape).digest("hex").slice(0, 12);
  const msg = message ? message.split("\n")[0]!.slice(0, 160) : undefined;
  console.warn(JSON.stringify({ tag: "sql-contract", kind, path, hash, shape: shape.slice(0, 300), ...(msg ? { message: msg } : {}) }));
  record(kind, path, hash, shape.slice(0, 300), msg);
}

// ---------------------------------------------------------------------------
// Contadores (em memoria, POR INSTANCIA, desde o inicio do processo) — para decidir quando ligar o `strict`
// sem depender de garimpar log. Nao guardam valores: so o "formato" da consulta (literais viram '?').
// ---------------------------------------------------------------------------

type Shape = { kind: string; path: string; hash: string; shape: string; count: number; lastAt: string; message?: string };
type StatsState = {
  shapes: Map<string, Shape>;
  totals: Map<string, number>; // path -> consultas traduzidas para Postgres
  kinds: Map<string, number>;  // kind -> ocorrencias
  startedAt: string;
};
// Singleton do PROCESSO: cada rota do Next pode ter sua propria copia deste modulo, e a rota que consulta
// (onde se conta) nao e a que exibe (configuracoes). globalThis garante um unico contador.
const G = globalThis as unknown as { __cwContractStats?: StatsState };
const state: StatsState = (G.__cwContractStats ??= { shapes: new Map(), totals: new Map(), kinds: new Map(), startedAt: new Date().toISOString() });
const { shapes, totals, kinds } = state;
const MAX_SHAPES = 500;

function record(kind: string, path: string, hash: string, shape: string, message?: string) {
  kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  const key = `${kind}|${path}|${hash}`;
  const cur = shapes.get(key);
  if (cur) { cur.count++; cur.lastAt = new Date().toISOString(); return; }
  if (shapes.size >= MAX_SHAPES) {
    // descarta o menos frequente
    let worst: string | null = null;
    for (const [k, v] of shapes) if (worst === null || v.count < shapes.get(worst)!.count) worst = k;
    if (worst) shapes.delete(worst);
  }
  shapes.set(key, { kind, path, hash, shape, count: 1, lastAt: new Date().toISOString(), ...(message ? { message } : {}) });
}

function countTranslated(path: string) {
  totals.set(path, (totals.get(path) ?? 0) + 1);
}

export function getContractStats() {
  return {
    since: state.startedAt,
    scope: "instancia",
    translated: Object.fromEntries(totals),
    byKind: Object.fromEntries(kinds),
    top: [...shapes.values()].sort((a, b) => b.count - a.count).slice(0, 30),
  };
}

export function resetContractStats() {
  shapes.clear();
  totals.clear();
  kinds.clear();
}
