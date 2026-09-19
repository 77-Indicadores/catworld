"use client";
import { StatusBadge } from "@/components/ui/primitives";
import { Time } from "@/components/ui/time";
import { fmtBytes } from "@/lib/fmt";
import { presentCount } from "@/lib/present";
import { derivedFreshness, tableFreshness } from "@/lib/workspace/present";
import type { WorkspaceDerived, WorkspaceTable } from "@/lib/workspace/types";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="shrink-0 text-base-content/70">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  );
}

/** Bloco "Frescor": está atualizado? quando foi, quando será, quantas linhas, houve erro? */
export function FreshnessBlock({ table, derived }: { table: WorkspaceTable; derived: WorkspaceDerived | null }) {
  const fresh = derived ? derivedFreshness(derived) : tableFreshness(table);
  const refresh = derived ?? table.source;
  const error = derived?.lastError ?? table.source?.lastError ?? null;
  const rows = presentCount(table.rowCount);
  const bytes = Number(table.sizeBytes);

  return (
    <section aria-labelledby="td-freshness" className="border-b border-base-300 p-4">
      <h4 id="td-freshness" className="mb-2.5 text-[11px] font-semibold text-base-content/70">Frescor</h4>
      <div className="mb-3"><StatusBadge status={fresh.tone} label={fresh.label} /></div>
      <dl className="space-y-1.5 text-xs">
        <Row label="Dados atualizados"><Time iso={table.lastDataAt} relative /></Row>
        {refresh && "lastRefreshedAt" in refresh && refresh.lastRefreshedAt && <Row label="Última sincronização"><Time iso={refresh.lastRefreshedAt} relative /></Row>}
        {refresh && refresh.nextRefreshAt && (table.source?.mode !== "live") && <Row label="Próxima"><Time iso={refresh.nextRefreshAt} /></Row>}
        <Row label="Linhas"><span title={rows?.title} className="tabular-nums">{rows?.exact ?? "—"}</span></Row>
        {bytes > 0 && <Row label="Tamanho">{fmtBytes(bytes)}</Row>}
      </dl>
      {fresh.reason && fresh.kind === "stale" && <p className="mt-2 text-xs text-warning">{fresh.reason}</p>}
      {error && (
        <div role="alert" className="mt-3 rounded bg-error/10 px-2 py-1.5 font-mono text-[11px] text-error">
          <p className="mb-0.5 font-sans font-medium">Última atualização falhou</p>
          {error}
        </div>
      )}
    </section>
  );
}
