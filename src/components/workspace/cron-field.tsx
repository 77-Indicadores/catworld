"use client";
import { Cron } from "croner";

const PRESETS: { label: string; cron: string }[] = [
  { label: "A cada hora", cron: "0 * * * *" },
  { label: "Todo dia às 03:00", cron: "0 3 * * *" },
  { label: "Dias úteis às 07:00", cron: "0 7 * * 1-5" },
  { label: "Toda segunda às 06:00", cron: "0 6 * * 1" },
];

export function isValidCron(expr: string): boolean {
  try {
    new Cron(expr.trim(), { timezone: "UTC" });
    return true;
  } catch {
    return false;
  }
}

const fmt = (d: Date) => d.toLocaleString("pt-BR", { timeZone: "UTC", dateStyle: "short", timeStyle: "short" }) + " UTC";

/**
 * Próximas execuções de um cron (sempre em UTC) e, se `onPick` vier, atalhos comuns. Expressão inválida é avisada
 * aqui e recusada pela API (400 INVALID_CRON) — a fonte nunca fica "agendada" sem rodar.
 */
export function CronPreview({ cron, onPick }: { cron: string; onPick?: (cron: string) => void }) {
  let content: React.ReactNode;
  try {
    const c = new Cron(cron.trim(), { timezone: "UTC" });
    const n1 = c.nextRun();
    const n2 = n1 ? c.nextRun(n1) : null;
    content = <span className="label-text-alt text-base-content/70">Próxima execução: {n1 ? fmt(n1) : "—"}{n2 ? ` · depois: ${fmt(n2)}` : ""}</span>;
  } catch {
    content = <span className="label-text-alt text-error">Expressão cron inválida. Exemplo: 0 3 * * * (todo dia às 03:00 UTC).</span>;
  }
  return (
    <span role="status" className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
      {content}
      {onPick && (
        <span className="flex flex-wrap gap-1">
          {PRESETS.map((p) => (
            <button type="button" key={p.cron} className="btn btn-ghost btn-xs" onClick={() => onPick(p.cron)} title={p.cron}>{p.label}</button>
          ))}
        </span>
      )}
    </span>
  );
}
