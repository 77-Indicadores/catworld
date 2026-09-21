/** Adaptadores do payload do workspace para a camada de apresentação (`lib/present`). Puro. */
import { presentRefreshFreshness, presentTableFreshness, type Freshness, type RefreshInput } from "@/lib/present";
import type { WorkspaceDerived, WorkspaceSource, WorkspaceTable } from "./types";

export function sourceRefreshInput(s: WorkspaceSource): RefreshInput {
  return {
    mode: s.mode, active: s.active, lastStatus: s.lastStatus, lastError: s.lastError,
    refreshCron: s.refreshCron, nextRefreshAt: s.nextRefreshAt, lastRefreshedAt: s.lastRefreshedAt, updatedAt: s.updatedAt ?? null,
  };
}

export function derivedRefreshInput(d: WorkspaceDerived): RefreshInput {
  return {
    mode: "extract", active: d.active, lastStatus: d.lastStatus, lastError: d.lastError,
    refreshCron: d.refreshCron, nextRefreshAt: d.nextRefreshAt, lastRefreshedAt: d.lastRefreshedAt, updatedAt: d.updatedAt ?? null,
  };
}

export const sourceFreshness = (s: WorkspaceSource, now?: Date): Freshness => presentRefreshFreshness(sourceRefreshInput(s), now);
export const derivedFreshness = (d: WorkspaceDerived, now?: Date): Freshness => presentRefreshFreshness(derivedRefreshInput(d), now);

/** Frescor da tabela: da fonte e/ou da derivada que a alimenta; só upload = neutro. */
export function tableFreshness(t: WorkspaceTable, derived: WorkspaceDerived | null = null, now?: Date): Freshness {
  return presentTableFreshness({ lastDataAt: t.lastDataAt, sources: t.source ? [sourceRefreshInput(t.source)] : [], derived: derived ? derivedRefreshInput(derived) : null }, now);
}

/** De onde a fonte lê: `schema.tabela` (fonte de tabela) ou "Consulta personalizada" (fonte de SQL). */
export function sourceOriginLabel(s: Pick<WorkspaceSource, "sourceKind" | "sourceSchema" | "sourceTable">): string {
  if (s.sourceKind === "table" && s.sourceTable) return s.sourceSchema ? `${s.sourceSchema}.${s.sourceTable}` : s.sourceTable;
  return "Consulta personalizada";
}
