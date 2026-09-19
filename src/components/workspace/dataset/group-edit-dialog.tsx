"use client";
import { useRef, useState } from "react";
import { Pencil, Plus, Search, Table2, Trash2 } from "lucide-react";
import { CronPreview } from "../cron-field";
import type { WorkspaceSource as Source, WorkspaceTable as Table } from "@/lib/workspace/types";

// ── Dialog to edit mode/cron + manage tables for a batch group ───────────
export function GroupEditDialog({ groupId, datasetId, connectionId, connectionName, sourceSchema, mode: initMode, initRefreshCron, sources, tables, onComplete }: {
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
              {mode !== "live" && refreshCron.trim() && <CronPreview cron={refreshCron} onPick={setRefreshCron} />}
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
                            ? <p className="px-3 py-2 text-xs text-base-content/40">Sem resultados para &ldquo;{pickerSearch}&rdquo;.</p>
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
