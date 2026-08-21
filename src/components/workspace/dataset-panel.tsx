"use client";
import { useRef, useState } from "react";
import { Cron } from "croner";
import { Cable, ChevronDown, Code2, Database, DatabaseZap, Pencil, Plus, RefreshCw, Search, Server, Table2, ToggleLeft, ToggleRight, Trash2, UploadCloud } from "lucide-react";
// Note: Pencil still used in GroupEditDialog and SourceEditDialog
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
  refreshCron: string | null;
  keyColumn: string | null; deltaColumn: string | null; active: boolean;
  lastStatus: string | null; lastRowCount: string | null; lastError: string | null;
  lastRefreshedAt: string | null; nextRefreshAt: string | null;
  connection: { id: string; name: string };
};
type Table = { id: string; name: string; lastDataAt: string | null; source: Source | null };
type DerivedTable = { id: string; name: string; sqlName: string; querySql: string; refreshCron: string | null; active: boolean; lastStatus: string | null; lastRowCount: string | null; lastError: string | null; lastRefreshedAt: string | null; nextRefreshAt: string | null; targetTable: { id: string; rowCount: string; lastDataAt: string | null } | null };
type StorageServerOption = { id: string; name: string; isDefault: boolean };
type Dataset = { id: string; slug: string; name: string; description: string | null; active: boolean; schemaName: string; storageServerId: string | null; storageServer: { id: string; name: string } | null; tables: Table[]; derivedTables: DerivedTable[] };

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

function isOverdue(source: Source): boolean {
  if (source.lastStatus !== "completed" && source.lastStatus !== "ready") return false;
  if (!source.nextRefreshAt || !source.refreshCron) return false;
  return new Date(source.nextRefreshAt) < new Date();
}

function statusKind(source: Source): "healthy" | "warning" | "error" | "inactive" {
  if (source.lastStatus === "failed") return "error";
  if (source.lastStatus === "running" || source.lastStatus === "queued") return "warning";
  if (source.lastStatus === "completed" || source.lastStatus === "ready") {
    if (isOverdue(source)) return "warning";
    return "healthy";
  }
  return "inactive";
}

function sourceBadge(source: Source) {
  if (!source.active) return { status: "inactive" as const, label: "Pausado" };
  const kind = statusKind(source);
  const overdue = isOverdue(source);
  return {
    status: kind,
    label: kind === "error" ? "Erro" : kind === "warning" ? (overdue ? "Atrasado" : "Processando") : kind === "healthy" ? "Pronto" : "Pendente",
  };
}

function refreshText(cron: string | null) {
  return cron ?? "Manual";
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
    if (!confirm(`Remover importacao com ${label}? Isto removera ${tables.length} tabela${tables.length !== 1 ? "s" : ""} deste dataset e os dados materializados no Catworld. A origem externa nao sera alterada.`)) return;
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
            <StatusBadge status={groupStatus} label={groupLabel} />
          </div>
          <p className="text-xs text-base-content/40">
            {tables.length} tabela{tables.length !== 1 ? "s" : ""}
            {" · " + (rep.mode === "extract" ? refreshText(rep.refreshCron) : "Ao vivo")}
            {rep.nextRefreshAt && rep.mode === "extract" && rep.refreshCron && (
              new Date(rep.nextRefreshAt) < new Date()
                ? <span className="text-warning"> · próx. sync atrasado</span>
                : <span> · próx. {new Date(rep.nextRefreshAt).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</span>
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

function CronPreview({ cron }: { cron: string }) {
  try {
    const c = new Cron(cron.trim(), { timezone: "UTC" });
    const n1 = c.nextRun();
    const n2 = n1 ? c.nextRun(n1) : null;
    const fmt = (d: Date) => d.toLocaleString("pt-BR", { timeZone: "UTC", dateStyle: "short", timeStyle: "short" }) + " UTC";
    return <span className="label-text-alt mt-1 text-base-content/55">Próximo: {n1 ? fmt(n1) : "—"}{n2 ? ` · depois: ${fmt(n2)}` : ""}</span>;
  } catch {
    return <span className="label-text-alt mt-1 text-warning">Expressão cron inválida</span>;
  }
}

// ── Dialog to edit mode/cron + manage tables for a batch group ───────────
function GroupEditDialog({ groupId, datasetId, connectionId, connectionName, sourceSchema, mode: initMode, initRefreshCron, sources, tables, onComplete }: {
  groupId: string; datasetId: string; connectionId: string; connectionName: string; sourceSchema: string | null;
  mode: string; initRefreshCron: string;
  sources: Source[]; tables: Table[]; onComplete: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState(initMode);
  const [refreshCron, setRefreshCron] = useState(initRefreshCron);
  const [saving, setSaving] = useState(false);

  const [showPicker, setShowPicker] = useState(false);
  const [loadingPicker, setLoadingPicker] = useState(false);
  const [availableTables, setAvailableTables] = useState<string[]>([]);
  const [selectedNew, setSelectedNew] = useState<string[]>([]);
  const [pickerSearch, setPickerSearch] = useState("");
  const [adding, setAdding] = useState(false);

  function openDialog() {
    setMode(initMode); setRefreshCron(initRefreshCron);
    setShowPicker(false); setSelectedNew([]); setAvailableTables([]); setPickerSearch("");
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
        refreshCron: mode === "live" ? null : (refreshCron.trim() || null),
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
      body: JSON.stringify({
        mode,
        refreshCron: mode === "live" ? null : (refreshCron.trim() || null),
      }),
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
              <span className="label-text font-medium">Agendamento (cron UTC)</span>
              <input
                className="input mt-1 w-full font-mono text-sm"
                placeholder="ex: 0 7-19/2 * * *  —  vazio = manual"
                value={refreshCron}
                onChange={e => setRefreshCron(e.target.value)}
                disabled={mode === "live"}
              />
              {mode !== "live" && refreshCron.trim() && <CronPreview cron={refreshCron} />}
              {mode !== "live" && !refreshCron.trim() && (
                <span className="label-text-alt mt-1 text-base-content/55">Vazio = sem agendamento automático</span>
              )}
              {mode === "live" && <span className="label-text-alt mt-1 text-base-content/55">Fontes ao vivo sempre consultam a origem na hora.</span>}
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
                <p className="py-2 text-xs text-base-content/40">Nenhuma tabela ou view nova disponível neste schema.</p>
              ) : (
                <>
                  {(() => {
                    const filtered = availableTables.filter(n => n.toLowerCase().includes(pickerSearch.toLowerCase()));
                    const allSelected = filtered.length > 0 && filtered.every(n => selectedNew.includes(n));
                    function toggleAll() {
                      if (allSelected) setSelectedNew(prev => prev.filter(n => !filtered.includes(n)));
                      else setSelectedNew(prev => [...new Set([...prev, ...filtered])]);
                    }
                    return (
                      <>
                        <div className="mb-2 flex items-center gap-2">
                          <label className="input input-xs flex flex-1 items-center gap-1.5 border border-base-300">
                            <Search size={11} className="text-base-content/40" />
                            <input type="text" className="grow" placeholder="Pesquisar..." value={pickerSearch} onChange={e => setPickerSearch(e.target.value)} />
                          </label>
                          <label className="flex cursor-pointer items-center gap-1 text-xs text-base-content/60 select-none whitespace-nowrap">
                            <input type="checkbox" className="checkbox checkbox-xs" checked={allSelected} onChange={toggleAll} disabled={filtered.length === 0} />
                            Todas
                          </label>
                        </div>
                        <div className="max-h-40 overflow-y-auto divide-y divide-base-300 rounded-lg border border-base-300">
                          {filtered.length === 0
                            ? <p className="px-3 py-2 text-xs text-base-content/40">Sem resultados para "{pickerSearch}".</p>
                            : filtered.map(name => (
                              <label key={name} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-base-200">
                                <input type="checkbox" className="checkbox checkbox-xs" checked={selectedNew.includes(name)} onChange={() => toggleNew(name)} />
                                <span className="text-xs font-mono">{name}</span>
                              </label>
                            ))
                          }
                        </div>
                        {selectedNew.length > 0 && (
                          <button className="btn btn-primary btn-xs gap-1 mt-2" disabled={adding} onClick={addTables}>
                            {adding ? <span className="loading loading-spinner loading-xs" /> : <Plus size={12} />}
                            {adding ? "Adicionando…" : "Adicionar " + selectedNew.length + (selectedNew.length === 1 ? " tabela" : " tabelas")}
                          </button>
                        )}
                      </>
                    );
                  })()}
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
    if (!confirm(`Remover a fonte "${s.name}"? Isto removera a tabela "${t.name}" deste dataset e os dados materializados no Catworld. A origem externa nao sera alterada.`)) return;
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
            <StatusBadge status={sourceBadge(s).status} label={sourceBadge(s).label} />
          </div>
          <p className="truncate text-xs text-base-content/40">
            {s.connection.name} · Consulta personalizada
            {s.mode === "extract" && " · " + refreshText(s.refreshCron)}
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

// ── Derived tables helpers ─────────────────────────────────────────────────
function derivedStatusKind(dt: DerivedTable): "healthy" | "warning" | "error" | "inactive" {
  if (!dt.active) return "inactive";
  if (dt.lastStatus === "failed") return "error";
  if (dt.lastStatus === "queued" || dt.lastStatus === "running") return "warning";
  if (dt.lastStatus === "ok") return "healthy";
  return "inactive";
}
function derivedStatusLabel(dt: DerivedTable): string {
  if (!dt.active) return "Pausado";
  if (dt.lastStatus === "failed") return "Erro";
  if (dt.lastStatus === "running") return "Processando";
  if (dt.lastStatus === "queued") return "Na fila";
  if (dt.lastStatus === "ok") return "Pronto";
  return "Pendente";
}

function DerivedCreateDialog({ datasetId, onComplete }: { datasetId: string; onComplete: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [querySql, setQuerySql] = useState("");
  const [refreshCron, setRefreshCron] = useState("");
  const [runNow, setRunNow] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function open() {
    setName(""); setQuerySql(""); setRefreshCron(""); setRunNow(true); setError("");
    dialogRef.current?.showModal();
  }
  function close() { dialogRef.current?.close(); }

  async function create() {
    setSaving(true); setError("");
    const r = await fetch(`/api/v1/datasets/${datasetId}/derived-tables`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, querySql, refreshCron: refreshCron.trim() || null, triggerNow: runNow }),
    });
    setSaving(false);
    if (!r.ok) { const b = await r.json().catch(() => ({})); setError(b.error ?? "Erro ao criar"); return; }
    close(); onComplete();
  }

  return (
    <>
      <button className="flex items-center gap-1 text-[10px] font-medium text-primary hover:underline" onClick={open}>
        <Plus size={12} />Nova derivada
      </button>
      <dialog ref={dialogRef} className="modal">
        <div className="modal-box max-w-lg">
          <h3 className="font-bold text-base">Nova tabela derivada</h3>
          <p className="mt-0.5 text-xs text-base-content/50">Tabela materializada a partir de uma consulta SQL</p>
          <div className="mt-4 space-y-3">
            <label className="form-control w-full">
              <span className="label-text font-medium">Nome da tabela</span>
              <input className="input mt-1 w-full" placeholder="ex: vendas_resumo" value={name} onChange={e => setName(e.target.value)} />
            </label>
            <label className="form-control w-full">
              <span className="label-text font-medium">SQL (SELECT)</span>
              <textarea
                className="textarea mt-1 w-full font-mono text-xs leading-relaxed"
                rows={8}
                placeholder={"SELECT ...\nFROM [schema].[tabela]"}
                value={querySql}
                onChange={e => setQuerySql(e.target.value)}
              />
            </label>
            <label className="form-control w-full">
              <span className="label-text font-medium">Agendamento (cron UTC)</span>
              <input
                className="input mt-1 w-full font-mono text-sm"
                placeholder="ex: 0 5 * * *  —  vazio = manual"
                value={refreshCron}
                onChange={e => setRefreshCron(e.target.value)}
              />
              {refreshCron.trim() ? <CronPreview cron={refreshCron} /> : (
                <span className="label-text-alt mt-1 text-base-content/55">Vazio = sem agendamento automático</span>
              )}
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm select-none">
              <input type="checkbox" className="checkbox checkbox-sm" checked={runNow} onChange={e => setRunNow(e.target.checked)} />
              Executar agora após criar
            </label>
          </div>
          {error && <p className="mt-3 text-xs text-error">{error}</p>}
          <div className="modal-action">
            <button className="btn btn-ghost btn-sm" onClick={close}>Cancelar</button>
            <button className="btn btn-primary btn-sm" disabled={saving || !name.trim() || !querySql.trim()} onClick={create}>
              {saving ? <><span className="loading loading-spinner loading-xs" />Criando…</> : "Criar tabela"}
            </button>
          </div>
        </div>
        <form method="dialog" className="modal-backdrop"><button onClick={close}>fechar</button></form>
      </dialog>
    </>
  );
}

function DerivedEditDialog({ dt, onComplete }: { dt: DerivedTable; onComplete: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(dt.name);
  const [querySql, setQuerySql] = useState(dt.querySql);
  const [refreshCron, setRefreshCron] = useState(dt.refreshCron ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function open() {
    setName(dt.name); setQuerySql(dt.querySql); setRefreshCron(dt.refreshCron ?? ""); setError("");
    dialogRef.current?.showModal();
  }
  function close() { dialogRef.current?.close(); }

  async function save() {
    setSaving(true); setError("");
    const r = await fetch(`/api/v1/derived-tables/${dt.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, querySql, refreshCron: refreshCron.trim() || null }),
    });
    setSaving(false);
    if (!r.ok) { const b = await r.json().catch(() => ({})); setError(b.error ?? "Erro ao salvar"); return; }
    close(); onComplete();
  }

  return (
    <>
      <button className="btn btn-ghost btn-xs gap-1" onClick={open}><Pencil size={13} />Editar</button>
      <dialog ref={dialogRef} className="modal">
        <div className="modal-box max-w-lg">
          <h3 className="font-bold text-base">Editar tabela derivada</h3>
          <p className="mt-0.5 font-mono text-xs text-base-content/40">{dt.sqlName}</p>
          <div className="mt-4 space-y-3">
            <label className="form-control w-full">
              <span className="label-text font-medium">Nome</span>
              <input className="input mt-1 w-full" value={name} onChange={e => setName(e.target.value)} />
            </label>
            <label className="form-control w-full">
              <span className="label-text font-medium">SQL</span>
              <textarea
                className="textarea mt-1 w-full font-mono text-xs leading-relaxed"
                rows={10}
                value={querySql}
                onChange={e => setQuerySql(e.target.value)}
              />
            </label>
            <label className="form-control w-full">
              <span className="label-text font-medium">Agendamento (cron UTC)</span>
              <input
                className="input mt-1 w-full font-mono text-sm"
                placeholder="ex: 0 5 * * *  —  vazio = manual"
                value={refreshCron}
                onChange={e => setRefreshCron(e.target.value)}
              />
              {refreshCron.trim() ? <CronPreview cron={refreshCron} /> : (
                <span className="label-text-alt mt-1 text-base-content/55">Vazio = sem agendamento automático</span>
              )}
            </label>
          </div>
          {error && <p className="mt-3 text-xs text-error">{error}</p>}
          <div className="modal-action">
            <button className="btn btn-ghost btn-sm" onClick={close}>Cancelar</button>
            <button className="btn btn-primary btn-sm" disabled={saving || !name.trim() || !querySql.trim()} onClick={save}>
              {saving ? <><span className="loading loading-spinner loading-xs" />Salvando…</> : "Salvar"}
            </button>
          </div>
        </div>
        <form method="dialog" className="modal-backdrop"><button onClick={close}>fechar</button></form>
      </dialog>
    </>
  );
}

function DerivedRow({ dt, schemaName, onSelectTable, onChanged }: {
  dt: DerivedTable; schemaName: string; onSelectTable: (id: string) => void; onChanged: () => void;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const status = derivedStatusKind(dt);
  const label = derivedStatusLabel(dt);
  const rowCount = dt.targetTable?.rowCount ?? dt.lastRowCount;

  async function triggerRefresh() {
    setRefreshing(true);
    await fetch(`/api/v1/derived-tables/${dt.id}/refresh`, { method: "POST" });
    setRefreshing(false);
    onChanged();
  }

  async function deleteDerived() {
    if (!confirm(`Excluir "${dt.name}"? A tabela materializada será removida do Catworld.`)) return;
    await fetch(`/api/v1/derived-tables/${dt.id}`, { method: "DELETE" });
    onChanged();
  }

  return (
    <div className="px-5 py-3">
      <div className="flex items-center gap-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-base-200 text-base-content/50">
          <Code2 size={13} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-base-content">{dt.name}</span>
            <StatusBadge status={status} label={label} />
          </div>
          <p className="truncate text-xs text-base-content/40">
            <span className="font-mono">{schemaName}.{dt.sqlName}</span>
            {fmtRows(rowCount) && <span> · {fmtRows(rowCount)} linhas</span>}
            {dt.refreshCron ? <span> · {dt.refreshCron}</span> : <span> · Manual</span>}
            {dt.nextRefreshAt && dt.refreshCron && (
              new Date(dt.nextRefreshAt) < new Date()
                ? <span className="text-warning"> · próx. sync atrasado</span>
                : <span> · próx. {new Date(dt.nextRefreshAt).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</span>
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

// ── Storage Server badge (read-only) ──────────────────────────────────────
function StorageServerBadge({ dataset, storageServers }: { dataset: Dataset; storageServers: StorageServerOption[] }) {
  const current = dataset.storageServerId
    ? storageServers.find(s => s.id === dataset.storageServerId)
    : storageServers.find(s => s.isDefault);
  return (
    <span className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-base-content/45" title="Servidor de armazenamento">
      <Server size={10} className="shrink-0" />
      {current?.name ?? "Servidor padrão"}
    </span>
  );
}

// ── Main panel ─────────────────────────────────────────────────────────────
export function DatasetPanel({ dataset, projectSlug, publicOrigin, storageServers, onSelectTable, onChanged }: {
  dataset: Dataset; projectSlug: string; publicOrigin: string; storageServers: StorageServerOption[];
  onSelectTable: (tableId: string) => void; onChanged: () => void;
}) {
  const derivedTargetIds = new Set(dataset.derivedTables.map(dt => dt.targetTable?.id).filter(Boolean));
  const uploadTables = dataset.tables.filter(t => !t.source && !derivedTargetIds.has(t.id));
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
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              <CopyableId value={dataset.id} label="Dataset ID" />
              {storageServers.length > 0 && (
                <StorageServerBadge dataset={dataset} storageServers={storageServers} />
              )}
            </div>
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

      {/* ── Derivadas ── */}
      <SectionHeader
        label={"Derivadas" + (dataset.derivedTables.length ? ` (${dataset.derivedTables.length})` : "")}
        action={<DerivedCreateDialog datasetId={dataset.id} onComplete={onChanged} />}
      />

      {dataset.derivedTables.length === 0 ? (
        <div className="flex items-center gap-3 px-5 py-4 text-xs text-base-content/40">
          <Code2 size={14} />
          <span>Nenhuma tabela derivada. Crie uma a partir de uma consulta SQL.</span>
        </div>
      ) : (
        <div className="divide-y divide-base-300">
          {dataset.derivedTables.map(dt => (
            <DerivedRow key={dt.id} dt={dt} schemaName={dataset.schemaName} onSelectTable={onSelectTable} onChanged={onChanged} />
          ))}
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
