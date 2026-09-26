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

export type FreshnessKind = "ok" | "stale" | "failing" | "running" | "paused" | "manual" | "live" | "neutral" | "empty" | "suspect";

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
  /** Ultima escrita da linha (ISO): para fonte "running" e o batimento (heartbeat) da trava, renovado a cada minuto (M2). */
  updatedAt?: string | null;
  /** Conexão tem um mecanismo de atualização automática que não depende de `refreshCron` (ex.: watch de arquivo
   * no FTP do provider firebird-ftp — ver `enqueueDueFirebirdFtpRefreshes`). Sem isto, "sem cron" era sempre
   * lido como "Manual", o que é falso para essas conexões: elas atualizam sozinhas ao detectar arquivo novo. */
  autoWatch?: boolean;
};

const F = (kind: FreshnessKind, label: string, tone: Status, severity: number, reason: string | null = null): Freshness => ({ kind, label, tone, reason, severity });

/** Fonte/arquivo veio vazio: o gate de integridade já barrou a publicação e manteve a tabela anterior — não é erro, é resultado vazio. */
const EMPTY_OUTCOME_RE = /Arquivo sem colunas|EMPTY_REPLACE/;
export function isEmptyOutcome(message: string | null | undefined): boolean {
  return !!message && EMPTY_OUTCOME_RE.test(message);
}

/** Cancelamento pedido pelo próprio usuário: grava `status: FAILED` com uma destas mensagens (ver rotas de
 * cancelamento em uploads/[id], uploads/cancel-all, dataset-sources/[id]/refresh), mas não é uma falha real do
 * sistema — não deve contar como erro, nem oferecer "tentar novamente". */
const CANCELLED_OUTCOME_RE = /^Cancelado pelo usuário$|^Cancelled$/;
export function isCancelledOutcome(message: string | null | undefined): boolean {
  return !!message && CANCELLED_OUTCOME_RE.test(message);
}

export function presentRefreshFreshness(src: RefreshInput, now: Date = new Date()): Freshness {
  if (src.active === false) return F("paused", "Pausada", "inactive", 1);
  const status = normalizeRunStatus(src.lastStatus);
  if (status === "failed") {
    if (isEmptyOutcome(src.lastError)) return F("empty", "Vazio (tabela anterior mantida)", "inactive", 2, src.lastError);
    if (isCancelledOutcome(src.lastError)) return F("paused", "Cancelada", "inactive", 2, src.lastError);
    return F("failing", "Com erro", "error", 6, src.lastError);
  }
  if (status === "running" || status === "queued") {
    // "Na fila"/"Atualizando" há muito tempo não é "em andamento": é parado. Antes esse estado voltava antes do teste de atraso e uma fonte
    // presa na fila por dias nunca aparecia como atrasada (docs/estudo-confiabilidade-dados.md, OBS-07).
    // `nextRefreshAt` so avanca quando a rodada TERMINA: uma rodada saudavel de 40 min parece "atrasada" por ele. Por isso "rodando"
    // se julga pelo batimento (updatedAt, renovado a cada minuto; parado ha mais de 20 min = dono morto) e, sem ele, por um limite
    // bem maior (2 h). So a fila (nada roda ainda) usa os 30 min sobre o horario previsto (M2).
    const next = src.nextRefreshAt ? Date.parse(src.nextRefreshAt) : NaN;
    const beat = src.updatedAt ? Date.parse(src.updatedAt) : NaN;
    const stuck = status === "queued"
      ? Number.isFinite(next) && now.getTime() - next > RUNNING_STUCK_MS
      : Number.isFinite(beat)
        ? now.getTime() - beat > RUNNING_HEARTBEAT_STUCK_MS
        : Number.isFinite(next) && now.getTime() - next > RUNNING_NO_HEARTBEAT_STUCK_MS;
    if (stuck) {
      const p = presentDateTime(status === "running" && Number.isFinite(beat) ? src.updatedAt : src.nextRefreshAt, { now });
      return F("stale", "Atrasada", "warning", 5, p ? `${status === "queued" ? "Na fila" : "Rodando"} desde antes de ${p.absolute}: possível travamento` : null);
    }
    return status === "running" ? F("running", "Atualizando", "warning", 4) : F("running", "Na fila", "warning", 4);
  }
  if (src.mode === "live") return F("live", "Ao vivo", "healthy", 2);
  if (!src.refreshCron && !src.nextRefreshAt) {
    if (status === "ok" || src.lastRefreshedAt) {
      return src.autoWatch
        ? F("manual", "Automática", "healthy", 1, "Sem cron: atualiza sozinha ao detectar arquivo novo na origem")
        : F("manual", "Manual", "healthy", 1, "Sem agenda: atualiza só quando você pedir");
    }
    return F("empty", "Aguardando 1ª carga", "warning", 3);
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

/** Fila/execução parada além disto (depois do horário previsto) deixa de ser "em andamento" e vira atraso. */
export const RUNNING_STUCK_MS = 30 * 60_000;
/** Rodando sem NENHUM batimento por este tempo = dono morto (o batimento e de 1 min; a trava e retomada apos ~15 min). */
export const RUNNING_HEARTBEAT_STUCK_MS = 20 * 60_000;
/** Rodando, sem dado de batimento (derivada/cliente antigo): so um limite folgado sobre o horario previsto, para nao acusar rodada longa. */
export const RUNNING_NO_HEARTBEAT_STUCK_MS = 2 * 3_600_000;

/** Veredito da última carga da tabela (livro de integridade): qualquer coisa diferente de OK torna o dado suspeito. */
export type IntegrityInput = { verdict: string; reason: string | null };

export type TableFreshnessInput = {
  lastDataAt: string | null;
  /** veredito da última carga (cw_load_ledger); ausente = sem informação, não julga */
  integrity?: IntegrityInput | null;
  sources: RefreshInput[];
  derived?: RefreshInput | null;
};

/**
 * Frescor de uma TABELA: se tem fonte/derivada, o pior estado entre elas; se só recebe upload (sem agenda) não há como
 * saber se está atrasada, então é neutro ("Atualizada há X") — sem julgar.
 */
export function presentTableFreshness(t: TableFreshnessInput, now: Date = new Date()): Freshness {
  const all = [...t.sources, ...(t.derived ? [t.derived] : [])];
  // Pausada/desativada (TODAS as origens) vem ANTES do veredito: uma fonte pausada nao vai mais carregar, entao "possivelmente
  // incompleta" ficaria para sempre sem como limpar (M1).
  if (all.length > 0 && all.every((s) => s.active === false)) return F("paused", "Pausada", "inactive", 1);
  // A última carga foi barrada ou marcada suspeita: o dado pode estar incompleto. Vence qualquer "Em dia" (gravidade 7 > erro 6).
  if (t.integrity && t.integrity.verdict !== "OK") {
    return F("suspect", "Possivelmente incompleta", "error", 7, t.integrity.reason);
  }
  const items = all.map((s) => presentRefreshFreshness(s, now));
  const worst = worstFreshness(items);
  if (worst) return worst;
  const p = presentDateTime(t.lastDataAt, { now });
  return p ? F("neutral", `Atualizada ${p.relative}`, "inactive", 0, p.absolute) : F("empty", "Sem dados", "inactive", 0);
}
