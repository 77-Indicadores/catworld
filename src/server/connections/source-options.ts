/**
 * Opcoes POR FONTE e marca de execucao, guardadas em `cw_system_settings` (chave/valor ja existente) para nao exigir migracao:
 *  - `source.options.<id>`  JSON permanente { allowEmpty?, maxDropPct?, onInvalid?, strict? }
 *  - `source.run.<id>`      JSON de uso unico { manual?, acceptDrop?, allowDropPct?, reconciliation?, at }
 *
 * Sem registro de opcoes = fonte LEGADA: valores irrepresentaveis viram NULL (comportamento antigo), decimais de ponto flutuante
 * acima de 15 digitos sao arredondados. Fonte NOVA grava `{ strict: true, onInvalid: "fail" }` na criacao (regra estrita).
 * Qualquer falha de leitura cai no padrao (a protecao nunca desliga por engano).
 */
import { prisma } from "@/server/db";
import type { IntegritySettings } from "@/server/integrity/policy";

export type SourceOptions = {
  /** esvaziar a tabela por uma leitura vazia e legitimo para esta fonte (ex.: consulta com janela sem dados no periodo) */
  allowEmpty?: boolean;
  /** queda maxima (%) aceita nesta fonte, no lugar do limite global */
  maxDropPct?: number;
  /** valor irrepresentavel no destino (infinity, data BC): "fail" (para a carga) ou "null" (NULL + aviso, comportamento antigo) */
  onInvalid?: "null" | "fail";
  /** fonte criada com a regra estrita de precisao (sem arredondar float de MSSQL acima de 15 digitos) */
  strict?: boolean;
};

export type RunMarker = { manual?: boolean; acceptDrop?: boolean; allowDropPct?: number; reconciliation?: boolean; at?: string };

const optKey = (id: string) => `source.options.${id}`;
const runKey = (id: string) => `source.run.${id}`;
const RUN_MARKER_TTL_MS = 6 * 3_600_000;

export function parseOptions(raw: string | null | undefined): SourceOptions {
  if (!raw) return {};
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const o: SourceOptions = {};
    if (typeof j.allowEmpty === "boolean") o.allowEmpty = j.allowEmpty;
    if (typeof j.maxDropPct === "number" && Number.isInteger(j.maxDropPct) && j.maxDropPct >= 1 && j.maxDropPct <= 99) o.maxDropPct = j.maxDropPct;
    if (j.onInvalid === "null" || j.onInvalid === "fail") o.onInvalid = j.onInvalid;
    if (typeof j.strict === "boolean") o.strict = j.strict;
    return o;
  } catch { return {}; }
}

async function readSetting(key: string): Promise<string | null> {
  const rows = await prisma.$queryRawUnsafe<{ value: string }[]>(`SELECT value FROM cw_system_settings WHERE key = $1`, key);
  return rows?.[0]?.value ?? null;
}
const writeSetting = (key: string, value: string) => prisma.$executeRawUnsafe(
  `INSERT INTO cw_system_settings (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`, key, value);

export async function getSourceOptions(sourceId: string): Promise<SourceOptions> {
  try { return parseOptions(await readSetting(optKey(sourceId))); } catch { return {}; }
}

/** Mescla `patch` (undefined = mantem) nas opcoes gravadas. */
export async function setSourceOptions(sourceId: string, patch: SourceOptions): Promise<SourceOptions> {
  const cur = await getSourceOptions(sourceId);
  const next: SourceOptions = { ...cur };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) (next as Record<string, unknown>)[k] = v;
  await writeSetting(optKey(sourceId), JSON.stringify(next));
  return next;
}

export async function clearSourceOptions(sourceId: string): Promise<void> {
  try { await prisma.$executeRawUnsafe(`DELETE FROM cw_system_settings WHERE key = ANY($1::text[])`, [optKey(sourceId), runKey(sourceId)]); } catch { /* best-effort */ }
}

/** Marca a PROXIMA rodada da fonte (manual pelo usuario / reconciliacao automatica de escalada). Nunca lanca. */
export async function setRunMarker(sourceId: string, marker: RunMarker): Promise<void> {
  try { await writeSetting(runKey(sourceId), JSON.stringify({ ...marker, at: new Date().toISOString() })); } catch { /* sem marca: a rodada segue como agendada */ }
}

/** Le e CONSOME a marca (uso unico). Marca velha, ilegivel ou de outro tipo de rodada (reconciliacao x incremental) e ignorada. */
export async function takeRunMarker(sourceId: string, reconciliation: boolean): Promise<RunMarker> {
  try {
    const rows = await prisma.$queryRawUnsafe<{ value: string }[]>(`SELECT value FROM cw_system_settings WHERE key = $1`, runKey(sourceId));
    const raw = rows?.[0]?.value;
    if (!raw) return {};
    const m = JSON.parse(raw) as RunMarker;
    if (m.reconciliation !== undefined && m.reconciliation !== reconciliation) return {};
    await prisma.$executeRawUnsafe(`DELETE FROM cw_system_settings WHERE key = $1`, runKey(sourceId));
    if (!m.at || Date.now() - Date.parse(m.at) > RUN_MARKER_TTL_MS) return {};
    return m;
  } catch { return {}; }
}

/**
 * Politica efetiva desta rodada: limites globais + override da fonte + marca da rodada.
 * `soft` = a barra nunca bloqueia (publica e marca SUSPECT): consulta com janela e sem chave (o resultado vazio/menor e normal)
 * e rodada manual (o usuario esta olhando). `acceptDrop` (rodada manual confirmada) e `allowDropPct` (reconciliacao
 * enfileirada pela escalada, com a fracao que a verificacao de chaves JA mediu) liberam a queda; a protecao global segue ligada
 * para fontes de tabela sem override.
 */
export function effectiveIntegrity(
  base: IntegritySettings, opts: SourceOptions, marker: RunMarker, ctx: { keylessWindowedQuery: boolean },
): { settings: IntegritySettings; scheduled: boolean; softEmpty: boolean } {
  let maxDropPct = opts.maxDropPct ?? base.maxDropPct;
  if (marker.allowDropPct != null) maxDropPct = Math.max(maxDropPct, Math.min(99, Math.ceil(marker.allowDropPct)));
  const allowEmpty = base.allowEmpty || !!opts.allowEmpty || !!marker.acceptDrop;
  if (marker.acceptDrop) maxDropPct = 99;
  return {
    settings: { ...base, maxDropPct, allowEmpty },
    scheduled: !marker.manual && !ctx.keylessWindowedQuery,
    softEmpty: ctx.keylessWindowedQuery,
  };
}
