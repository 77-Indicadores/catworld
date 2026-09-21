/**
 * Guardas e configuracao das fontes conectadas: resolucao de colunas (FON-14), contador de verificacoes de exclusao
 * ignoradas (FON-12), lease de execucao (FON-17), configuracao (janela de sobreposicao, tolerancia de futuro, limite de
 * escalada) e aviso de fantasmas por falta de deteccao de exclusoes (FON-06).
 */
import { prisma } from "@/server/db";
import { sqlIdentifier } from "@/server/security/naming";
import { DEFAULT_FUTURE_TOLERANCE_HOURS, DEFAULT_LOOKBACK_MINUTES } from "./source-delta";

// ── Colunas (FON-14) ─────────────────────────────────────────────────────────────────────────────────────────────────

type NamedCol = { originalName: string; sqlName: string };

/**
 * A coluna de delta/chave e gravada como o usuario digitou; a origem conhece o nome ORIGINAL ("Id") e o storage o nome
 * saneado ("id"). Resolve de forma consistente: original exato, saneado exato, original sem caixa, saneado do texto.
 */
export function resolveColumn<T extends NamedCol>(columns: T[], name: string | null | undefined): T | null {
  if (!name) return null;
  const lower = name.toLowerCase();
  return columns.find(c => c.originalName === name)
    ?? columns.find(c => c.sqlName === name)
    ?? columns.find(c => c.originalName.toLowerCase() === lower)
    ?? columns.find(c => c.sqlName === sqlIdentifier(name))
    ?? null;
}

// ── Escalada de verificacoes de exclusao ignoradas (FON-12) ─────────────────────────────────────────────────────────

export const KEYS_SKIP_CODES = ["KEYS_CHECK_UNSAFE", "KEYS_CHECK_FAILED", "KEYS_READ_FAILED"] as const;
const SKIP_RE = /(KEYS_(?:CHECK_UNSAFE|CHECK_FAILED|READ_FAILED))\[skips=(\d+)\]:/;

/** Quantas rodadas seguidas ja ignoraram a verificacao (o contador vive no proprio aviso gravado em lastError). */
export function previousKeysSkips(lastError: string | null | undefined): number {
  const m = lastError ? SKIP_RE.exec(lastError) : null;
  return m ? Number(m[2]) : 0;
}

/** Trecho do aviso de chaves (com contador) dentro de um lastError composto, para carregar entre rodadas sem verificacao devida. */
export function extractKeysWarning(lastError: string | null | undefined): string | null {
  if (!lastError) return null;
  return lastError.split(" | ").find(p => SKIP_RE.test(p)) ?? null;
}

/** "KEYS_CHECK_UNSAFE: msg" -> "KEYS_CHECK_UNSAFE[skips=N]: msg" */
export function withSkipCount(warning: string, skips: number): string {
  return warning.replace(/^(KEYS_[A-Z_]+):/, `$1[skips=${skips}]:`);
}

export const isSkipWarning = (w: string | null) => !!w && KEYS_SKIP_CODES.some(c => w.startsWith(`${c}:`));

// ── Configuracao ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type SourceSettings = { lookbackMinutes: number; futureToleranceHours: number; keysEscalateAfter: number; staleLeaseMinutes: number };
export const SOURCE_SETTING_KEYS = {
  lookbackMinutes: "source.delta_lookback_minutes",
  futureToleranceHours: "source.delta_future_tolerance_hours",
  keysEscalateAfter: "source.keys_skip_escalate_after",
  staleLeaseMinutes: "source.stale_lease_minutes",
} as const;
export const SOURCE_DEFAULTS: SourceSettings = { lookbackMinutes: DEFAULT_LOOKBACK_MINUTES, futureToleranceHours: DEFAULT_FUTURE_TOLERANCE_HOURS, keysEscalateAfter: 3, staleLeaseMinutes: 15 };

const int = (v: string | undefined, d: number, min: number, max: number) => {
  if (v == null || v.trim() === "") return d;
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : d;
};

/** Le de cw_system_settings; qualquer falha ou valor invalido cai no padrao (a protecao nunca desliga por engano). 0 desliga a escalada. */
export async function getSourceSettings(): Promise<SourceSettings> {
  try {
    const rows = await prisma.$queryRawUnsafe<{ key: string; value: string }[]>(
      `SELECT key, value FROM cw_system_settings WHERE key = ANY($1::text[])`,
      Object.values(SOURCE_SETTING_KEYS),
    );
    const by = Object.fromEntries(rows.map(r => [r.key, r.value]));
    return {
      lookbackMinutes: int(by[SOURCE_SETTING_KEYS.lookbackMinutes], SOURCE_DEFAULTS.lookbackMinutes, 0, 10_080),
      futureToleranceHours: int(by[SOURCE_SETTING_KEYS.futureToleranceHours], SOURCE_DEFAULTS.futureToleranceHours, 0, 8_760),
      keysEscalateAfter: int(by[SOURCE_SETTING_KEYS.keysEscalateAfter], SOURCE_DEFAULTS.keysEscalateAfter, 0, 1000),
      staleLeaseMinutes: int(by[SOURCE_SETTING_KEYS.staleLeaseMinutes], SOURCE_DEFAULTS.staleLeaseMinutes, 2, 1_440),
    };
  } catch {
    return SOURCE_DEFAULTS;
  }
}

// ── Lease (FON-17) ───────────────────────────────────────────────────────────────────────────────────────────────────

export const LEASE_PREFIX = "lease:";
export const LEASE_HEARTBEAT_MS = 60_000;
export const leaseMarker = (token: string) => `${LEASE_PREFIX}${token}`;

// ── Fantasmas por falta de deteccao de exclusoes (FON-06) ────────────────────────────────────────────────────────────

export const DEFAULT_RECONCILIATION_CRON = "15 3 * * *";

export type DeletionCoverageInput = {
  mode?: string | null; keyColumn?: string | null; detectDeletions?: boolean | null; reconciliationCron?: string | null;
  sourceKind?: string | null; sourceSqlReconciliation?: string | null;
};

/**
 * Fonte extract com chave cujas exclusoes na origem nao sao detectadas por nada (nem a verificacao de chaves, nem a
 * reconciliacao periodica): linhas apagadas na origem ficam vivas para sempre com status "completed".
 */
export function deletionCoverageWarning(s: DeletionCoverageInput): string | null {
  if (s.mode !== "extract" || !s.keyColumn?.trim()) return null;
  if (s.detectDeletions || s.reconciliationCron?.trim()) return null;
  const how = s.sourceKind === "query"
    ? "ative a deteccao de exclusoes (com consulta de chaves) ou cadastre uma consulta e um cron de reconciliacao"
    : "ative a deteccao de exclusoes ou um cron de reconciliacao";
  return `NO_DELETION_DETECTION: linhas apagadas na origem continuam vivas nesta tabela (nada detecta exclusoes); ${how}.`;
}

/** Fonte nova com chave: reconciliacao diaria por padrao quando e segura (tabela, ou consulta com consulta de reconciliacao). */
export function defaultReconciliationCron(i: DeletionCoverageInput & { reconciliationCron?: string | null | undefined }): string | null {
  if (i.mode !== "extract" || !i.keyColumn?.trim() || i.detectDeletions) return null;
  if (i.reconciliationCron !== undefined) return null; // escolha explicita (inclusive null = sem reconciliacao) e respeitada
  if (i.sourceKind === "query" && !i.sourceSqlReconciliation?.trim()) return null;
  return DEFAULT_RECONCILIATION_CRON;
}
