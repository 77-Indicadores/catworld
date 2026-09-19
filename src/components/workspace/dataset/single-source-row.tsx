"use client";
import { useState } from "react";
import { Cable, DatabaseZap, RefreshCw, Table2, ToggleLeft, ToggleRight, Trash2 } from "lucide-react";
import { StatusBadge } from "@/components/ui/primitives";
import { SourceEditDialog } from "../source-edit-dialog";
import { useApiAction, useFeedback } from "@/components/ui/feedback";
import type { WorkspaceSource as Source, WorkspaceTable as Table } from "@/lib/workspace/types";
import { fmtRows, refreshText, sourceBadge } from "./helpers";
import { sourceOriginLabel } from "@/lib/workspace/present";
import { Time } from "@/components/ui/time";

// ── Single source row (query fonte or legacy without groupId) ──────────────
export function SingleSourceRow({ source: s, table: t, onSelectTable, onChanged }: {
  source: Source; table: Table; onSelectTable: (id: string) => void; onChanged: () => void;
}) {
  const { confirm: askConfirm } = useFeedback(); const runAction = useApiAction();
  const [refreshing, setRefreshing] = useState(false);

  async function refreshSource() {
    setRefreshing(true);
    await fetch(`/api/v1/dataset-sources/${s.id}/refresh`, { method: "POST" });
    setRefreshing(false);
    onChanged();
  }

  async function deleteSource() {
    if (!await askConfirm({ title: "Remover fonte", message: `Remover a fonte "${s.name}"? Isto removerá a tabela "${t.name}" deste dataset e os dados materializados no Catworld. A origem externa não será alterada.`, confirmLabel: "Remover", danger: true })) return;
    if (await runAction(`/api/v1/dataset-sources/${s.id}`, { method: "DELETE" }, "Fonte removida.")) onChanged();
  }

  async function toggleActive() {
    await fetch(`/api/v1/dataset-sources/${s.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: !s.active }),
    });
    onChanged();
  }

  return (
    <div className={"px-5 py-3 " + (s.active ? "" : "opacity-50")}>
      <div className="flex items-center gap-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-base-200 text-base-content/65">
          {s.mode === "live" ? <Cable size={13} /> : <DatabaseZap size={13} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-base-content">{s.name}</span>
            <StatusBadge status={sourceBadge(s).status} label={sourceBadge(s).label} />
          </div>
          <p className="truncate text-xs text-base-content/65">
            {s.connection.name} · {sourceOriginLabel(s)}
            {s.mode === "extract" && " · " + refreshText(s.refreshCron)}
            {fmtRows(s.lastRowCount) && " · " + fmtRows(s.lastRowCount) + " linhas"}
            {s.lastRefreshedAt && <> · atualizada <Time iso={s.lastRefreshedAt} relative /></>}
          </p>
        </div>
        <button onClick={() => onSelectTable(t.id)} className="btn btn-ghost btn-xs gap-1 shrink-0">
          <Table2 size={12} />Abrir
        </button>
      </div>

      {s.lastError && (
        <div className="mt-2 rounded bg-error/8 px-2 py-1 font-mono text-[11px] text-error">{s.lastError}</div>
      )}

      <div className="mt-2 flex items-center gap-1">
        <SourceEditDialog source={{ ...s, sourceSql: s.sourceSql }} onComplete={onChanged} />
        <button onClick={toggleActive} className="btn btn-ghost btn-xs gap-1">
          {s.active
            ? <ToggleRight size={13} className="text-success" />
            : <ToggleLeft size={13} className="text-base-content/65" />}
          {s.active ? "Sync ativo" : "Sync pausado"}
        </button>
        {s.mode === "extract" && (
          <button onClick={refreshSource} disabled={!s.active || refreshing || s.lastStatus === "running"} className="btn btn-ghost btn-xs gap-1">
            <RefreshCw size={12} className={refreshing || s.lastStatus === "running" ? "animate-spin" : ""} />
            {refreshing ? "..." : s.lastStatus === "failed" ? "Tentar novamente" : "Atualizar"}
          </button>
        )}
        <button onClick={deleteSource} className="btn btn-ghost btn-xs text-error/60 hover:text-error ml-auto" title="Remover fonte">
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}
