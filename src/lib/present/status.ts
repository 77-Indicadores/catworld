/**
 * Estado e frescor de fontes, derivadas e tabelas — UMA regra para todas as telas (substitui os cinco mapeadores
 * paralelos e o `lastStatus` cru). Puro: `now` injetado.
 *
 * Vocabulário do backend: fonte `queued|running|completed|failed|ready`; derivada `queued|running|ok|failed`.
 */
import type { Status } from "@/lib/types";
import { presentDateTime } from "./datetime";

export type RunStatus = "queued" | "running" | "ok" | "failed" | "unknown";

export function normalizeRunStatus(raw: string | null | undefined): RunStatus {
  switch ((raw ?? "").toLowerCase()) {
    case "completed": case "ok": case "ready": case "success": return "ok";
    case "queued": case "pending": return "queued";
    case "running": case "processing": return "running";
    case "failed": case "error": return "failed";
    default: return "unknown";
  }
}

export type FreshnessKind = "ok" | "stale" | "failing" | "running" | "paused" | "manual" | "live" | "neutral" | "empty";

export type Freshness = {
  kind: FreshnessKind;
  /** Texto do badge, em português. */
  label: string;
  /** Mapeia para o `StatusBadge` existente. */
  tone: Status;
  /** Motivo curto (ex.: a mensagem de erro, ou "próxima execução prevista para …"). */
  reason: string | null;
  /** Gravidade para agregar (maior = pior). */
  severity: number;
};

/** Atraso tolerado depois de `nextRefreshAt`: 2 min ou 10% do intervalo entre execuções, o que for maior. */
export const STALE_MIN_TOLERANCE_MS = 2 * 60_000;
export function staleToleranceMs(intervalMs: number): number {
  return Math.max(STALE_MIN_TOLERANCE_MS, Math.round(intervalMs * 0.1));
}

export type RefreshInput = {
  /** `extract` | `live` (derivada = extract). */
  mode?: string | null;
  /** Fonte/derivada ativa (padrão true). */
  active?: boolean | null;
  lastStatus: string | null;
  lastError: string | null;
  refreshCron: string | null;
  nextRefreshAt: string | null;
  lastRefreshedAt: string | null;
};

const F = (kind: FreshnessKind, label: string, tone: Status, severity: number, reason: string | null = null): Freshness => ({ kind, label, tone, reason, severity });

export function presentRefreshFreshness(src: RefreshInput, now: Date = new Date()): Freshness {
  if (src.active === false) return F("paused", "Pausada", "inactive", 1);
  const status = normalizeRunStatus(src.lastStatus);
  if (status === "failed") return F("failing", "Com erro", "error", 6, src.lastError);
  if (status === "running") return F("running", "Atualizando", "warning", 4);
  if (status === "queued") return F("running", "Na fila", "warning", 4);
  if (src.mode === "live") return F("live", "Ao vivo", "healthy", 2);
  if (!src.refreshCron && !src.nextRefreshAt) {
    return status === "ok" || src.lastRefreshedAt ? F("manual", "Manual", "inactive", 1) : F("empty", "Aguardando 1ª carga", "warning", 3);
  }
  if (src.nextRefreshAt) {
    const next = Date.parse(src.nextRefreshAt);
    const last = src.lastRefreshedAt ? Date.parse(src.lastRefreshedAt) : NaN;
    const interval = Number.isFinite(last) && Number.isFinite(next) ? Math.max(0, next - last) : 0;
    if (Number.isFinite(next) && now.getTime() > next + staleToleranceMs(interval)) {
      const p = presentDateTime(src.nextRefreshAt, { now });
      return F("stale", "Atrasada", "warning", 5, p ? `Deveria ter atualizado em ${p.absolute}` : null);
    }
  }
  if (status === "unknown" && !src.lastRefreshedAt) return F("empty", "Aguardando 1ª carga", "warning", 3);
  return F("ok", "Em dia", "healthy", 3);
}

/** Pior estado da lista (falhando > atrasada > atualizando > em dia > ao vivo > pausada/manual). */
export function worstFreshness(list: Freshness[]): Freshness | null {
  if (list.length === 0) return null;
  return list.reduce((worst, f) => (f.severity > worst.severity ? f : worst));
}

export type TableFreshnessInput = {
  lastDataAt: string | null;
  sources: RefreshInput[];
  derived?: RefreshInput | null;
};

/**
 * Frescor de uma TABELA: se tem fonte/derivada, o pior estado entre elas; se só recebe upload (sem agenda) não há como
 * saber se está atrasada, então é neutro ("Atualizada há X") — sem julgar.
 */
export function presentTableFreshness(t: TableFreshnessInput, now: Date = new Date()): Freshness {
  const items = [...t.sources, ...(t.derived ? [t.derived] : [])].map((s) => presentRefreshFreshness(s, now));
  const worst = worstFreshness(items);
  if (worst) return worst;
  const p = presentDateTime(t.lastDataAt, { now });
  return p ? F("neutral", `Atualizada ${p.relative}`, "inactive", 0, p.absolute) : F("empty", "Sem dados", "inactive", 0);
}
