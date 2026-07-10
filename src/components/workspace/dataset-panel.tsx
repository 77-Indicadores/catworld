"use client";
import { useState } from "react";
import { Cable, Database, DatabaseZap, RefreshCw, Table2, Trash2, UploadCloud, ToggleLeft, ToggleRight } from "lucide-react";
import { CopyableId } from "@/components/ui/copyable-id";
import { EditCatalogDialog } from "@/components/management/edit-catalog-dialog";
import { EmptyState, Panel, StatusBadge } from "@/components/ui/primitives";
import { UploadFlow } from "./upload-flow";
import { SourceDialog } from "./source-dialog";
import { SourceEditDialog } from "./source-edit-dialog";
import { PowerBIDialog } from "./powerbi-dialog";

type Source = { id: string; name: string; mode: string; sourceKind: string; sourceSchema: string | null; sourceTable: string | null; refreshPolicy: string; active: boolean; lastStatus: string | null; lastRowCount: string | null; lastError: string | null; lastRefreshedAt: string | null; nextRefreshAt: string | null; connection: { id: string; name: string } };
type Table = { id: string; name: string; source: Source | null };
type Dataset = { id: string; slug: string; name: string; description: string | null; active: boolean; tables: Table[] };

function modeText(mode: string) {
  return mode === "live" ? "Consulta ao vivo" : "Cópia no Catworld";
}

function statusKind(status: string | null): "healthy" | "warning" | "error" | "inactive" {
  if (status === "completed" || status === "ready") return "healthy";
  if (status === "failed") return "error";
  if (status === "running" || status === "queued") return "warning";
  return "inactive";
}

function refreshText(policy: string) {
  return { manual: "Manual", hourly: "A cada hora", daily: "Diária", weekly: "Semanal" }[policy] ?? policy;
}

function fmtRows(n: string | null) {
  if (!n) return null;
  const v = Number(n);
  if (isNaN(v)) return null;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M linhas`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}K linhas`;
  return `${v.toLocaleString("pt-BR")} linhas`;
}

export function DatasetPanel({ dataset, projectSlug, publicOrigin, onSelectTable, onChanged }: { dataset: Dataset; projectSlug: string; publicOrigin: string; onSelectTable: (tableId: string) => void; onChanged: () => void }) {
  const sourceTables = dataset.tables.filter((t) => t.source);
  const uploadTables = dataset.tables.filter((t) => !t.source);
  const [refreshing, setRefreshing] = useState<string | null>(null);

  async function refreshSource(id: string) {
    setRefreshing(id);
    await fetch(`/api/v1/dataset-sources/${id}/refresh`, { method: "POST" });
    setRefreshing(null);
    onChanged();
  }

  async function deleteSource(id: string, name: string) {
    if (!confirm(`Remover a fonte "${name}"? Os dados já copiados não serão apagados.`)) return;
    await fetch(`/api/v1/dataset-sources/${id}`, { method: "DELETE" });
    onChanged();
  }

  async function toggleActive(id: string, active: boolean) {
    await fetch(`/api/v1/dataset-sources/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: !active }),
    });
    onChanged();
  }

  return (
    <div className="space-y-5">
      <div className="rounded-box border border-base-300 bg-base-100 p-5">
        <div className="flex items-start justify-between gap-3">
          <div><h2 className="text-lg font-semibold">{dataset.name}</h2><p className="mt-1 text-sm text-base-content/55">{dataset.description}</p></div>
          <div className="flex items-center gap-2">
            <PowerBIDialog projectSlug={projectSlug} datasetSlug={dataset.slug} datasetName={dataset.name} publicOrigin={publicOrigin} />
            <EditCatalogDialog kind="dataset" id={dataset.id} name={dataset.name} description={dataset.description} active={dataset.active} />
          </div>
        </div>
        <div className="mt-3"><CopyableId value={dataset.id} label="Dataset ID" /></div>
      </div>

      <Panel title="Fontes conectadas" action={<SourceDialog datasetId={dataset.id} onComplete={onChanged} />}>
        {sourceTables.length === 0 ? (
          <EmptyState icon={<DatabaseZap size={26} />} title="Nenhuma fonte conectada" description="Adicione uma tabela ou consulta Postgres para copiar dados ou consultar a origem ao vivo." action={<SourceDialog datasetId={dataset.id} onComplete={onChanged} />} />
        ) : (
          <div className="grid gap-3 p-4 lg:grid-cols-2">
            {sourceTables.map((t) => {
              const s = t.source!;
              const isRefreshing = refreshing === s.id;
              const rowsLabel = fmtRows(s.lastRowCount);
              return (
                <div key={s.id} className={`rounded-box border bg-base-100 p-4 transition-opacity ${s.active ? "border-base-300" : "border-base-300 opacity-60"}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className="grid size-8 place-items-center rounded-lg bg-primary/10 text-primary">
                        {s.mode === "live" ? <Cable size={16} /> : <DatabaseZap size={16} />}
                      </span>
                      <div>
                        <h3 className="font-medium">{s.name}</h3>
                        <p className="text-xs text-base-content/50">{s.connection.name}</p>
                      </div>
                    </div>
                    <StatusBadge status={statusKind(s.lastStatus)} label={s.lastStatus ?? "Pronta"} />
                  </div>

                  <dl className="mt-4 grid gap-2 text-xs text-base-content/65">
                    <div><dt className="font-medium text-base-content">Modo</dt><dd>{modeText(s.mode)}</dd></div>
                    <div><dt className="font-medium text-base-content">Origem</dt><dd>{s.sourceKind === "table" ? `${s.sourceSchema}.${s.sourceTable}` : "Consulta personalizada"}</dd></div>
                    <div><dt className="font-medium text-base-content">Atualização</dt><dd>{s.mode === "live" ? "Sempre ao consultar" : refreshText(s.refreshPolicy)}</dd></div>
                    {rowsLabel && <div><dt className="font-medium text-base-content">Dados</dt><dd>{rowsLabel}</dd></div>}
                    {s.lastRefreshedAt && <div><dt className="font-medium text-base-content">Última atualização</dt><dd>{new Date(s.lastRefreshedAt).toLocaleString("pt-BR")}</dd></div>}
                    {s.nextRefreshAt && <div><dt className="font-medium text-base-content">Próxima atualização</dt><dd>{new Date(s.nextRefreshAt).toLocaleString("pt-BR")}</dd></div>}
                  </dl>

                  {s.lastError && <div className="alert alert-error alert-soft mt-3 text-xs">{s.lastError}</div>}

                  <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex gap-1">
                      <button className="btn btn-ghost btn-xs" onClick={() => onSelectTable(t.id)} title="Abrir tabela">
                        <Table2 size={13} />Abrir
                      </button>
                      <SourceEditDialog source={s} onComplete={onChanged} />
                      <button
                        className="btn btn-ghost btn-xs"
                        onClick={() => toggleActive(s.id, s.active)}
                        title={s.active ? "Desativar fonte" : "Ativar fonte"}
                      >
                        {s.active ? <ToggleRight size={13} className="text-success" /> : <ToggleLeft size={13} className="text-base-content/40" />}
                        {s.active ? "Ativa" : "Inativa"}
                      </button>
                    </div>
                    <div className="flex gap-1">
                      {s.mode === "extract" && (
                        <button
                          className="btn btn-outline btn-xs"
                          onClick={() => refreshSource(s.id)}
                          disabled={isRefreshing || s.lastStatus === "running"}
                        >
                          <RefreshCw size={13} className={isRefreshing || s.lastStatus === "running" ? "animate-spin" : ""} />
                          {isRefreshing ? "Enfileirando..." : "Atualizar agora"}
                        </button>
                      )}
                      <button
                        className="btn btn-ghost btn-xs text-error"
                        onClick={() => deleteSource(s.id, s.name)}
                        title="Remover fonte"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      <Panel title="Tabelas de upload">
        {uploadTables.length > 0
          ? <div className="divide-y divide-base-300">{uploadTables.map((t) => <button key={t.id} onClick={() => onSelectTable(t.id)} className="flex w-full items-center gap-3 px-5 py-3 text-left text-sm hover:bg-base-200"><Database size={15} className="text-primary" /><span>{t.name}</span></button>)}</div>
          : <div className="px-5 py-4 text-sm text-base-content/50">Nenhuma tabela criada por upload neste dataset.</div>}
      </Panel>

      <Panel title="Novo upload">
        <div className="p-4">
          <div className="mb-3 flex items-center gap-2 text-sm text-base-content/60"><UploadCloud size={15} />Envie CSV, XLSX ou XLS para criar ou atualizar tabelas materializadas.</div>
          <UploadFlow datasetId={dataset.id} onComplete={onChanged} />
        </div>
      </Panel>
    </div>
  );
}
