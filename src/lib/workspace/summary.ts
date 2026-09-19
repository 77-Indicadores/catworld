/** Resumo de frescor de várias tabelas (dashboard, sidebar): quem está com erro, atrasado, atualizando. Puro. */
import type { Freshness } from "@/lib/present";
import type { Status } from "@/lib/types";

export type FreshnessItem = { key: string; name: string; group: string; href?: string; freshness: Freshness };

export type FreshnessSummary = {
  total: number;
  failing: FreshnessItem[];
  stale: FreshnessItem[];
  running: FreshnessItem[];
  /** Em dia (fonte agendada ou ao vivo/manual saudáveis). */
  healthy: number;
  /** Só upload (sem agenda): não dá para julgar. */
  neutral: number;
  paused: number;
};

export function summarizeFreshness(items: FreshnessItem[]): FreshnessSummary {
  const s: FreshnessSummary = { total: items.length, failing: [], stale: [], running: [], healthy: 0, neutral: 0, paused: 0 };
  for (const it of items) {
    switch (it.freshness.kind) {
      case "failing": s.failing.push(it); break;
      case "stale": s.stale.push(it); break;
      case "running": s.running.push(it); break;
      case "ok": case "live": case "manual": s.healthy++; break;
      case "paused": s.paused++; break;
      default: s.neutral++; // neutral | empty
    }
  }
  return s;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Selo do resumo: o pior problema primeiro; sem problema, "Em dia" só se algo agendado está em dia. */
export function freshnessHeadline(s: FreshnessSummary): { tone: Status; label: string } {
  if (s.total === 0) return { tone: "inactive", label: "Sem tabelas" };
  if (s.failing.length) return { tone: "error", label: plural(s.failing.length, "com erro", "com erro") };
  if (s.stale.length) return { tone: "warning", label: plural(s.stale.length, "atrasada", "atrasadas") };
  if (s.running.length) return { tone: "warning", label: "Atualizando" };
  if (s.healthy > 0) return { tone: "healthy", label: "Em dia" };
  return { tone: "inactive", label: "Sem agenda" };
}
