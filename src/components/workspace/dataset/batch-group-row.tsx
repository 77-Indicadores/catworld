"use client";
import { useState } from "react";
import { Cable, DatabaseZap, RefreshCw, Table2, ToggleLeft, ToggleRight, Trash2 } from "lucide-react";
import { StatusBadge } from "@/components/ui/primitives";
import { useApiAction, useFeedback } from "@/components/ui/feedback";
import type { WorkspaceSource as Source, WorkspaceTable as Table } from "@/lib/workspace/types";
import { Time } from "@/components/ui/time";
import { GroupEditDialog } from "./group-edit-dialog";
import { refreshText, sourceBadge } from "./helpers";

// ── Batch group row (N tables from one import) ─────────────────────────────
export function BatchGroupRow({ groupId, datasetId, sources, tables, onSelectTable, onChanged }: {
  groupId: string; datasetId: string; sources: Source[]; tables: Table[];
  onSelectTable: (id: string) => void; onChanged: () => void;
}) {
  const { confirm: askConfirm } = useFeedback(); const runAction = useApiAction();
  const [refreshing, setRefreshing] = useState(false);
  const rep = sources[0]!; // representative source — all share mode/policy/status/connection
  const activeSources = sources.filter(s => s.active);
  const failedSources = sources.filter(s => s.active && s.lastStatus === "failed");
  const runningSources = sources.filter(s => s.active && (s.lastStatus === "running" || s.lastStatus === "queued"));
  const completedSources = sources.filter(s => s.active && (s.lastStatus === "completed" || s.lastStatus === "ready"));

  const groupStatus = failedSources.length ? "error" : runningSources.length ? "warning" : activeSources.length ? "healthy" : "inactive";
  const groupLabel = groupStatus === "error" ? "Erro" : groupStatus === "warning" ? "Processando" : groupStatus === "healthy" ? "Pronto" : "Pausado";
  const groupSummary = failedSources.length
    ? `${completedSources.length} concluida${completedSources.length !== 1 ? "s" : ""} · ${failedSources.length} com erro`
    : runningSources.length
      ? `${runningSources.length} processando · ${completedSources.length} concluida${completedSources.length !== 1 ? "s" : ""}`
      : activeSources.length
        ? `${completedSources.length} concluida${completedSources.length !== 1 ? "s" : ""}`
        : "Sync pausado; dados mantidos como snapshot";

  const allActive = activeSources.length === sources.length;

  async function toggleGroup() {
    await fetch(`/api/v1/source-groups/${groupId}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: !allActive }),
    });
    onChanged();
  }

  async function refreshGroup() {
    setRefreshing(true);
    const targets = failedSources.length ? failedSources : activeSources;
    await Promise.all(targets.map(s => fetch(`/api/v1/dataset-sources/${s.id}/refresh`, { method: "POST" })));
    setRefreshing(false);
    onChanged();
  }

  async function deleteGroup() {
    const label = `${tables.length} tabela${tables.length !== 1 ? "s" : ""} de ${rep.sourceSchema ?? rep.connection.name}`;
    if (!await askConfirm({ title: "Remover importação", message: `Remover a importação com ${label}? Isto removerá ${tables.length} tabela${tables.length !== 1 ? "s" : ""} deste dataset e os dados materializados no Catworld. A origem externa não será alterada.`, confirmLabel: "Remover", danger: true })) return;
    if (await runAction(`/api/v1/source-groups/${groupId}`, { method: "DELETE" }, "Importação removida.")) onChanged();
  }

  return (
    <div className={"px-5 py-3 " + (allActive ? "" : "opacity-50")}>
      <div className="flex items-center gap-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-base-200 text-base-content/50">
          {rep.mode === "live" ? <Cable size={13} /> : <DatabaseZap size={13} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-base-content">
              {rep.sourceSchema ? `${rep.connection.name} · ${rep.sourceSchema}` : rep.connection.name}
            </span>
            <StatusBadge status={groupStatus} label={groupLabel} />
          </div>
          <p className="text-xs text-base-content/40">
            {tables.length} tabela{tables.length !== 1 ? "s" : ""}
            {" · " + (rep.mode === "extract" ? refreshText(rep.refreshCron) : "Ao vivo")}
            {rep.nextRefreshAt && rep.mode === "extract" && rep.refreshCron && (
              new Date(rep.nextRefreshAt) < new Date()
                ? <span className="text-warning"> · próx. sync atrasado</span>
                : <span> · próx. <Time iso={rep.nextRefreshAt} /></span>
            )}
            {" · " + groupSummary}
          </p>
        </div>
      </div>

      {/* Tabelas do grupo */}
      <div className="mt-2 ml-10 divide-y divide-base-300 rounded-lg border border-base-300">
        {tables.map(t => (
          <div key={t.id} className="group flex items-center gap-1 first:rounded-t-lg last:rounded-b-lg hover:bg-base-200">
            <button
              onClick={() => onSelectTable(t.id)}
              className="flex flex-1 items-center gap-2 px-3 py-1.5 text-left text-xs"
            >
              <Table2 size={11} className="shrink-0 text-base-content/40" />
              <span className="flex-1 truncate font-mono">{t.name}</span>
              {t.source && <StatusBadge status={sourceBadge(t.source).status} label={sourceBadge(t.source).label} />}
              {t.lastDataAt && (
                <span className="shrink-0 text-base-content/60"><Time iso={t.lastDataAt} /></span>
              )}
            </button>
            <button
              onClick={async () => {
                if (tables.length <= 1 && !await askConfirm({ title: "Remover a última tabela", message: "Remover a última tabela apagará a importação inteira. Continuar?", confirmLabel: "Remover", danger: true })) return;
                if (await runAction("/api/v1/dataset-sources/" + t.source!.id, { method: "DELETE" }, "Tabela removida.")) onChanged();
              }}
              className="mr-1 hidden rounded p-1 text-error/30 hover:text-error group-hover:block"
              title="Remover tabela"
            >
              <Trash2 size={11} />
            </button>
          </div>
        ))}
      </div>

      {/* Erros */}
      {sources.some(s => s.lastError) && (
        <div className="mt-2 ml-10 rounded bg-error/8 px-2 py-1 font-mono text-[11px] text-error">
          {(failedSources[0]?.sourceTable ?? failedSources[0]?.name ?? sources.find(s => s.lastError)?.name) + ": "}{failedSources[0]?.lastError ?? sources.find(s => s.lastError)?.lastError}
        </div>
      )}

      {/* Ações do grupo — mode/policy editados via GroupEditDialog */}
      <div className="mt-2 flex items-center gap-1">
        <GroupEditDialog groupId={groupId} datasetId={datasetId} connectionId={rep.connection.id} connectionName={rep.connection.name} sourceSchema={rep.sourceSchema} mode={rep.mode} initRefreshCron={rep.refreshCron ?? ""} sources={sources} tables={tables} onComplete={onChanged} />
        <button onClick={toggleGroup} className="btn btn-ghost btn-xs gap-1">
          {allActive
            ? <ToggleRight size={13} className="text-success" />
            : <ToggleLeft size={13} className="text-base-content/30" />}
          {allActive ? "Sync ativo" : "Sync pausado"}
        </button>
        {rep.mode === "extract" && (
          <button onClick={refreshGroup} disabled={refreshing || activeSources.length === 0} className="btn btn-ghost btn-xs gap-1">
            <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} />
            {refreshing ? "..." : failedSources.length ? "Tentar novamente" : "Atualizar"}
          </button>
        )}
        <button onClick={deleteGroup} className="btn btn-ghost btn-xs text-error/60 hover:text-error ml-auto" title="Remover importação">
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}
