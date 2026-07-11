"use client";
import { useRef, useState } from "react";
import { Cable, ChevronDown, Database, DatabaseZap, Pencil, Plus, RefreshCw, Table2, ToggleLeft, ToggleRight, Trash2, UploadCloud } from "lucide-react";
import { CopyableId } from "@/components/ui/copyable-id";
import { EditCatalogDialog } from "@/components/management/edit-catalog-dialog";
import { StatusBadge } from "@/components/ui/primitives";
import { UploadFlow } from "./upload-flow";
import { SourceDialog } from "./source-dialog";
import { SourceEditDialog } from "./source-edit-dialog";
import { PowerBIDialog } from "./powerbi-dialog";

type Source = {
  id: string; name: string; mode: string; sourceKind: string;
  sourceGroupId: string | null;
  sourceSchema: string | null; sourceTable: string | null; sourceSql: string | null;
  refreshPolicy: string; active: boolean;
  lastStatus: string | null; lastRowCount: string | null; lastError: string | null;
  lastRefreshedAt: string | null; nextRefreshAt: string | null;
  connection: { id: string; name: string };
};
type Table = { id: string; name: string; lastDataAt: string | null; source: Source | null };
type Dataset = { id: string; slug: string; name: string; description: string | null; active: boolean; tables: Table[] };

// A group is either:
//   - Multiple table sources that share a sourceGroupId (batch import)
//   - A single query source (no sourceGroupId, or its own group)
type SourceGroup =
  | { kind: "batch"; groupId: string; sources: Source[]; tables: Table[] }
  | { kind: "single"; source: Source; table: Table };

function buildGroups(tables: Table[]): SourceGroup[] {
  const groups: SourceGroup[] = [];
  const batchMap = new Map<string, { sources: Source[]; tables: Table[] }>();

  for (const t of tables) {
    const s = t.source;
    if (!s) continue;
    if (s.sourceGroupId) {
      if (!batchMap.has(s.sourceGroupId)) batchMap.set(s.sourceGroupId, { sources: [], tables: [] });
      const g = batchMap.get(s.sourceGroupId)!;
      if (!g.sources.find(x => x.id === s.id)) g.sources.push(s);
      g.tables.push(t);
    } else {
      groups.push({ kind: "single", source: s, table: t });
    }
  }

  for (const [groupId, { sources, tables: batchTables }] of batchMap) {
    groups.push({ kind: "batch", groupId, sources, tables: batchTables });
  }

  return groups;
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
  const v = Number(n);
  if (!n || isNaN(v)) return null;
  if (v >= 1_000_000) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1e3).toFixed(0)}K`;
  return v.toLocaleString("pt-BR");
}

function SectionHeader({ label, action }: { label: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-base-300 px-5 py-2">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-base-content/40">{label}</span>
      {action}
    </div>
  );
}

// ── Batch group row (N tables from one import) ─────────────────────────────
function BatchGroupRow({ groupId, datasetId, sources, tables, onSelectTable, onChanged }: {
  groupId: string; datasetId: string; sources: Source[]; tables: Table[];
  onSelectTable: (id: string) => void; onChanged: () => void;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const rep = sources[0]!; // representative source — all share mode/policy/status/connection

  // Aggregate status: failed > running/queued > completed > inactive
  const worstStatus = sources.reduce<"healthy" | "warning" | "error" | "inactive">((acc, s) => {
    const k = statusKind(s.lastStatus);
    if (k === "error") return "error";
    if (k === "warning" && acc !== "error") return "warning";
    if (k === "healthy" && acc === "inactive") return "healthy";
    return acc;
  }, "inactive");

  const allActive = sources.every(s => s.active);

  async function toggleGroup() {
    await fetch(`/api/v1/source-groups/${groupId}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: !allActive }),
    });
    onChanged();
  }

  async function refreshGroup() {
    setRefreshing(true);
    await Promise.all(sources.map(s => fetch(`/api/v1/dataset-sources/${s.id}/refresh`, { method: "POST" })));
    setRefreshing(false);
    onChanged();
  }

  async function deleteGroup() {
    const label = `${tables.length} tabela${tables.length !== 1 ? "s" : ""} de ${rep.sourceSchema ?? rep.connection.name}`;
    if (!confirm(`Remover importação com ${label}? Os dados já copiados não serão apagados.`)) return;
    await fetch(`/api/v1/source-groups/${groupId}`, { method: "DELETE" });
    onChanged();
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
            <StatusBadge status={worstStatus} label={worstStatus === "error" ? "Erro" : worstStatus === "warning" ? "Processando" : worstStatus === "healthy" ? "OK" : "Pronta"} />
          </div>
          <p className="text-xs text-base-content/40">
            {tables.length} tabela{tables.length !== 1 ? "s" : ""}
            {" · " + (rep.mode === "extract" ? refreshText(rep.refreshPolicy) : "Ao vivo")}
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
              {t.lastDataAt && (
                <span className="shrink-0 text-base-content/30">{new Date(t.lastDataAt).toLocaleDateString("pt-BR")}</span>
              )}
            </button>
            <button
              onClick={async () => {
                if (tables.length <= 1 && !confirm("Remover a última tabela apagará a importação inteira. Continuar?")) return;
                await fetch("/api/v1/dataset-sources/" + t.source!.id, { method: "DELETE" });
                onChanged();
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
          {sources.find(s => s.lastError)?.lastError}
        </div>
      )}

      {/* Ações do grupo — mode/policy editados via GroupEditDialog */}
      <div className="mt-2 flex items-center gap-1">
        <GroupEditDialog groupId={groupId} datasetId={datasetId} connectionId={rep.connection.id} connectionName={rep.connection.name} sourceSchema={rep.sourceSchema} mode={rep.mode} refreshPolicy={rep.refreshPolicy} sources={sources} tables={tables} onComplete={onChanged} />
        <button onClick={toggleGroup} className="btn btn-ghost btn-xs gap-1">
          {allActive
            ? <ToggleRight size={13} className="text-success" />
            : <ToggleLeft size={13} className="text-base-content/30" />}
          {allActive ? "Ativa" : "Inativa"}
        </button>
        {rep.mode === "extract" && (
          <button onClick={refreshGroup} disabled={refreshing} className="btn btn-ghost btn-xs gap-1">
            <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} />
            {refreshing ? "…" : "Atualizar"}
          </button>
        )}
        <button onClick={deleteGroup} className="btn btn-ghost btn-xs text-error/60 hover:text-error ml-auto" title="Remover importação">
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}

// ── Dialog to edit mode/policy + manage tables for a batch group ───────────
function GroupEditDialog({ groupId, datasetId, connectionId, connectionName, sourceSchema, mode: initMode, refreshPolicy: initPolicy, sources, tables, onComplete }: {
  groupId: string; datasetId: string; connectionId: string; connectionName: string; sourceSchema: string | null;
  mode: string; refreshPolicy: string; sources: Source[]; tables: Table[]; onComplete: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState(initMode);
  const [policy, setPolicy] = useState(initPolicy);
  const [saving, setSaving] = useState(false);

  const [showPicker, setShowPicker] = useState(false);
  const [loadingPicker, setLoadingPicker] = useState(false);
  const [availableTables, setAvailableTables] = useState<string[]>([]);
  const [selectedNew, setSelectedNew] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);

  function openDialog() {
    setMode(initMode); setPolicy(initPolicy);
    setShowPicker(false); setSelectedNew([]); setAvailableTables([]);
    dialogRef.current?.showModal();
  }
  function closeDialog() { dialogRef.current?.close(); }

  async function loadPicker() {
    setShowPicker(true); setLoadingPicker(true);
    const qs = sourceSchema ? "?schema=" + encodeURIComponent(sourceSchema) : "";
    const res = await fetch("/api/v1/connections/" + connectionId + "/tables" + qs);
    const data = await res.json();
    const existing = new Set(sources.map(s => s.sourceTable).filter(Boolean));
    setAvailableTables((data.tables ?? []).filter((t: string) => !existing.has(t)));
    setLoadingPicker(false);
  }

  function toggleNew(name: string) {
    setSelectedNew(prev => prev.includes(name) ? prev.filter(x => x !== name) : [...prev, name]);
  }

  async function addTables() {
    if (!selectedNew.length) return;
    setAdding(true);
    await fetch("/api/v1/datasets/" + datasetId + "/sources", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connectionId, mode, sourceKind: "table", sourceSchema,
        sourceTables: selectedNew,
        refreshPolicy: mode === "live" ? "manual" : policy,
        sourceGroupId: groupId,
      }),
    });
    setAdding(false); setShowPicker(false); setSelectedNew([]);
    closeDialog(); onComplete();
  }

  async function removeTable(sourceId: string) {
    await fetch("/api/v1/dataset-sources/" + sourceId, { method: "DELETE" });
    onComplete();
  }

  async function save() {
    setSaving(true);
    await fetch("/api/v1/source-groups/" + groupId, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode, refreshPolicy: mode === "live" ? "manual" : policy }),
    });
    setSaving(false); closeDialog(); onComplete();
  }

  const subtitle = connectionName + (sourceSchema ? " · " + sourceSchema : "");

  return (
    <>
      <button className="btn btn-ghost btn-xs gap-1" onClick={openDialog}>
        <Pencil size={13} />Editar importação
      </button>
      <dialog ref={dialogRef} className="modal">
        <div className="modal-box max-w-md">
          <h3 className="font-bold text-base">Editar importação</h3>
          <p className="mt-0.5 text-xs text-base-content/50">{subtitle}</p>

          <p className="mt-4 text-[11px] font-semibold uppercase tracking-wider text-base-content/40">Configurações</p>
          <div className="mt-2 space-y-3">
            <label className="form-control w-full">
              <span className="label-text font-medium">Modo</span>
              <select className="select mt-1 w-full" value={mode} onChange={e => setMode(e.target.value)}>
                <option value="extract">Copiar para o Catworld</option>
                <option value="live">Consultar direto na origem</option>
              </select>
            </label>
            <label className="form-control w-full">
              <span className="label-text font-medium">Atualização automática</span>
              <select className="select mt-1 w-full" disabled={mode === "live"} value={policy} onChange={e => setPolicy(e.target.value)}>
                <option value="manual">Manual</option>
                <option value="hourly">A cada hora</option>
                <option value="daily">Diária</option>
                <option value="weekly">Semanal</option>
              </select>
            </label>
          </div>

          <p className="mt-5 text-[11px] font-semibold uppercase tracking-wider text-base-content/40">Tabelas</p>
          <div className="mt-2 max-h-48 overflow-y-auto divide-y divide-base-300 rounded-lg border border-base-300">
            {tables.map(t => (
              <div key={t.id} className="flex items-center gap-2 px-3 py-1.5">
                <Table2 size={11} className="shrink-0 text-base-content/40" />
                <span className="flex-1 truncate text-xs font-mono">{t.name}</span>
                <button
                  onClick={() => removeTable(t.source!.id)}
                  disabled={tables.length <= 1}
                  className="rounded p-1 text-error/30 hover:text-error disabled:opacity-20"
                  title={tables.length <= 1 ? "Não é possível remover a última tabela" : "Remover tabela"}
                >
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
          </div>

          {!showPicker ? (
            <button className="btn btn-ghost btn-xs gap-1 mt-2" onClick={loadPicker}>
              <Plus size={12} />Adicionar tabelas
            </button>
          ) : (
            <div className="mt-3">
              {loadingPicker ? (
                <div className="flex items-center gap-2 py-2 text-xs text-base-content/50">
                  <span className="loading loading-spinner loading-xs" />Carregando tabelas…
                </div>
              ) : availableTables.length === 0 ? (
                <p className="py-2 text-xs text-base-content/40">Nenhuma tabela nova disponível neste schema.</p>
              ) : (
                <>
                  <div className="max-h-40 overflow-y-auto divide-y divide-base-300 rounded-lg border border-base-300">
                    {availableTables.map(name => (
                      <label key={name} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-base-200">
                        <input type="checkbox" className="checkbox checkbox-xs" checked={selectedNew.includes(name)} onChange={() => toggleNew(name)} />
                        <span className="text-xs font-mono">{name}</span>
                      </label>
                    ))}
                  </div>
                  {selectedNew.length > 0 && (
                    <button className="btn btn-primary btn-xs gap-1 mt-2" disabled={adding} onClick={addTables}>
                      {adding ? <span className="loading loading-spinner loading-xs" /> : <Plus size={12} />}
                      {adding ? "Adicionando…" : "Adicionar " + selectedNew.length + (selectedNew.length === 1 ? " tabela" : " tabelas")}
                    </button>
                  )}
                </>
              )}
            </div>
          )}

          <div className="modal-action">
            <button className="btn btn-ghost btn-sm" onClick={closeDialog}>Cancelar</button>
            <button className="btn btn-primary btn-sm" disabled={saving} onClick={save}>
              {saving ? "Salvando…" : "Salvar configurações"}
            </button>
          </div>
        </div>
        <form method="dialog" className="modal-backdrop"><button onClick={closeDialog}>fechar</button></form>
      </dialog>
    </>
  );
}

// ── Single source row (query fonte or legacy without groupId) ──────────────
function SingleSourceRow({ source: s, table: t, onSelectTable, onChanged }: {
  source: Source; table: Table; onSelectTable: (id: string) => void; onChanged: () => void;
}) {
  const [refreshing, setRefreshing] = useState(false);

  async function refreshSource() {
    setRefreshing(true);
    await fetch(`/api/v1/dataset-sources/${s.id}/refresh`, { method: "POST" });
    setRefreshing(false);
    onChanged();
  }

  async function deleteSource() {
    if (!confirm(`Remover a fonte "${s.name}"? Os dados já copiados não serão apagados.`)) return;
    await fetch(`/api/v1/dataset-sources/${s.id}`, { method: "DELETE" });
    onChanged();
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
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-base-200 text-base-content/50">
          {s.mode === "live" ? <Cable size={13} /> : <DatabaseZap size={13} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-base-content">{s.name}</span>
            <StatusBadge status={statusKind(s.lastStatus)} label={s.lastStatus ?? "Pronta"} />
          </div>
          <p className="truncate text-xs text-base-content/40">
            {s.connection.name} · Consulta personalizada
            {s.mode === "extract" && " · " + refreshText(s.refreshPolicy)}
            {fmtRows(s.lastRowCount) && " · " + fmtRows(s.lastRowCount) + " linhas"}
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
            : <ToggleLeft size={13} className="text-base-content/30" />}
          {s.active ? "Ativa" : "Inativa"}
        </button>
        {s.mode === "extract" && (
          <button onClick={refreshSource} disabled={refreshing || s.lastStatus === "running"} className="btn btn-ghost btn-xs gap-1">
            <RefreshCw size={12} className={refreshing || s.lastStatus === "running" ? "animate-spin" : ""} />
            {refreshing ? "…" : "Atualizar"}
          </button>
        )}
        <button onClick={deleteSource} className="btn btn-ghost btn-xs text-error/60 hover:text-error ml-auto" title="Remover fonte">
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}

// ── Main panel ─────────────────────────────────────────────────────────────
export function DatasetPanel({ dataset, projectSlug, publicOrigin, onSelectTable, onChanged }: {
  dataset: Dataset; projectSlug: string; publicOrigin: string;
  onSelectTable: (tableId: string) => void; onChanged: () => void;
}) {
  const uploadTables = dataset.tables.filter(t => !t.source);
  const sourceGroups = buildGroups(dataset.tables);
  const [uploadOpen, setUploadOpen] = useState(false);

  async function deleteTable(id: string, name: string) {
    if (!confirm(`Excluir a tabela "${name}"? Esta ação não pode ser desfeita.`)) return;
    await fetch(`/api/v1/tables/${id}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmName: name }) });
    onChanged();
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto text-sm">

      {/* ── Header ── */}
      <div className="border-b border-base-300 px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate font-semibold">{dataset.name}</h2>
            {dataset.description && <p className="mt-0.5 truncate text-xs text-base-content/45">{dataset.description}</p>}
            <div className="mt-2"><CopyableId value={dataset.id} label="Dataset ID" /></div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <PowerBIDialog projectSlug={projectSlug} datasetSlug={dataset.slug} datasetName={dataset.name} publicOrigin={publicOrigin} />
            <EditCatalogDialog kind="dataset" id={dataset.id} name={dataset.name} description={dataset.description} active={dataset.active} />
          </div>
        </div>
      </div>

      {/* ── Fontes ── */}
      <SectionHeader
        label={"Fontes" + (sourceGroups.length ? ` (${sourceGroups.length})` : "")}
        action={<SourceDialog datasetId={dataset.id} onComplete={onChanged} />}
      />

      {sourceGroups.length === 0 ? (
        <div className="flex items-center gap-3 px-5 py-4 text-xs text-base-content/40">
          <DatabaseZap size={14} />
          <span>Nenhuma fonte conectada.</span>
        </div>
      ) : (
        <div className="divide-y divide-base-300">
          {sourceGroups.map(g =>
            g.kind === "batch"
              ? <BatchGroupRow key={g.groupId} {...g} datasetId={dataset.id} onSelectTable={onSelectTable} onChanged={onChanged} />
              : <SingleSourceRow key={g.source.id} {...g} onSelectTable={onSelectTable} onChanged={onChanged} />
          )}
        </div>
      )}

      {/* ── Tabelas de upload ── */}
      <SectionHeader label={"Tabelas" + (uploadTables.length ? ` (${uploadTables.length})` : "")} />

      {uploadTables.length === 0 ? (
        <div className="flex items-center gap-3 px-5 py-4 text-xs text-base-content/40">
          <Database size={14} />
          <span>Nenhuma tabela de upload. Faça um upload abaixo.</span>
        </div>
      ) : (
        <div className="divide-y divide-base-300">
          {uploadTables.map(t => (
            <div key={t.id} className="flex items-center gap-2 px-5 py-2 hover:bg-base-200">
              <button onClick={() => onSelectTable(t.id)} className="flex flex-1 items-center gap-3 text-left text-xs">
                <Database size={13} className="shrink-0 text-primary" />
                <span className="flex-1 truncate font-medium">{t.name}</span>
                {t.lastDataAt && (
                  <span className="shrink-0 text-base-content/35">{new Date(t.lastDataAt).toLocaleDateString("pt-BR")}</span>
                )}
              </button>
              <button onClick={() => deleteTable(t.id, t.name)} className="btn btn-ghost btn-xs text-error/50 hover:text-error" title="Excluir tabela">
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── Upload ── */}
      <SectionHeader
        label="Upload"
        action={
          <button onClick={() => setUploadOpen(o => !o)} className="flex items-center gap-1 text-[10px] font-medium text-primary hover:underline">
            {uploadOpen ? <ChevronDown size={12} /> : <Plus size={12} />}
            {uploadOpen ? "Fechar" : "Novo upload"}
          </button>
        }
      />

      {uploadOpen ? (
        <div className="px-5 py-4">
          <UploadFlow datasetId={dataset.id} onComplete={() => { onChanged(); setUploadOpen(false); }} />
        </div>
      ) : (
        <button onClick={() => setUploadOpen(true)} className="flex items-center gap-3 px-5 py-4 text-left text-xs text-base-content/40 hover:bg-base-200 hover:text-base-content/60">
          <UploadCloud size={14} />
          <span>Arraste um CSV, XLSX ou XLS aqui, ou clique para selecionar</span>
        </button>
      )}
    </div>
  );
}
