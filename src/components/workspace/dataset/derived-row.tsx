"use client";
import { useState } from "react";
import { Code2, RefreshCw, Table2, Trash2 } from "lucide-react";
import { StatusBadge } from "@/components/ui/primitives";
import { useApiAction, useFeedback } from "@/components/ui/feedback";
import type { WorkspaceDerived as DerivedTable } from "@/lib/workspace/types";
import { Time } from "@/components/ui/time";
import { DerivedEditDialog } from "./derived-dialogs";
import { fmtRows } from "./helpers";
import { derivedFreshness } from "@/lib/workspace/present";

export function DerivedRow({ dt, schemaName, onSelectTable, onChanged }: {
  dt: DerivedTable; schemaName: string; onSelectTable: (id: string) => void; onChanged: () => void;
}) {
  const { confirm: askConfirm } = useFeedback(); const runAction = useApiAction();
  const [refreshing, setRefreshing] = useState(false);
  const fresh = derivedFreshness(dt);
  const status = fresh.tone;
  const label = fresh.label;
  const rowCount = dt.targetTable?.rowCount ?? dt.lastRowCount;

  async function triggerRefresh() {
    setRefreshing(true);
    await fetch(`/api/v1/derived-tables/${dt.id}/refresh`, { method: "POST" });
    setRefreshing(false);
    onChanged();
  }

  async function deleteDerived() {
    if (!await askConfirm({ title: "Excluir tabela derivada", message: `Excluir "${dt.name}"? A tabela materializada será removida do Catworld.`, confirmLabel: "Excluir", danger: true })) return;
    if (await runAction(`/api/v1/derived-tables/${dt.id}`, { method: "DELETE" }, "Tabela derivada excluída.")) onChanged();
  }

  return (
    <div className="px-5 py-3">
      <div className="flex items-center gap-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-base-200 text-base-content/65">
          <Code2 size={13} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-base-content">{dt.name}</span>
            <StatusBadge status={status} label={label} />
          </div>
          <p className="truncate text-xs text-base-content/65">
            <span className="font-mono">{schemaName}.{dt.sqlName}</span>
            {fmtRows(rowCount) && <span> · {fmtRows(rowCount)} linhas</span>}
            {dt.refreshCron ? <span> · {dt.refreshCron}</span> : <span> · Manual</span>}
            {dt.nextRefreshAt && dt.refreshCron && (
              new Date(dt.nextRefreshAt) < new Date()
                ? <span className="text-warning"> · próx. sync atrasado</span>
                : <span> · próx. <Time iso={dt.nextRefreshAt} /></span>
            )}
          </p>
        </div>
        {dt.targetTable && (
          <button onClick={() => onSelectTable(dt.targetTable!.id)} className="btn btn-ghost btn-xs gap-1 shrink-0">
            <Table2 size={12} />Abrir
          </button>
        )}
      </div>

      {dt.lastError && (
        <div className="mt-2 rounded bg-error/8 px-2 py-1 font-mono text-[11px] text-error">{dt.lastError}</div>
      )}

      <div className="mt-2 flex items-center gap-1">
        <DerivedEditDialog dt={dt} onComplete={onChanged} />
        <button
          onClick={triggerRefresh}
          disabled={refreshing || dt.lastStatus === "running" || dt.lastStatus === "queued"}
          className="btn btn-ghost btn-xs gap-1"
        >
          <RefreshCw size={12} className={(refreshing || dt.lastStatus === "running") ? "animate-spin" : ""} />
          {refreshing ? "..." : dt.lastStatus === "failed" ? "Tentar novamente" : "Atualizar"}
        </button>
        <button onClick={deleteDerived} className="btn btn-ghost btn-xs text-error/60 hover:text-error ml-auto" title="Excluir derivada">
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}
