"use client";
import { useState } from "react";
import { RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { apiRequest, errorMessage } from "@/lib/api-client";
import type { WorkspaceDataset as Dataset, WorkspaceTable as Table } from "@/lib/workspace/types";
import { FreshnessBlock } from "./table-detail/freshness-block";
import { OriginBlock } from "./table-detail/origin-block";
import { UsageBlock } from "./table-detail/usage-block";
import { HistoryBlock } from "./table-detail/history-block";
import { CopyId } from "./copy-id";

function DeleteTableButton({ tableId, tableName, onDeleted }: { tableId: string; tableName: string; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(""), [deleting, setDeleting] = useState(false), [error, setError] = useState("");

  async function destroy() {
    setDeleting(true); setError("");
    try {
      await apiRequest(`/api/v1/tables/${tableId}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmName: confirm }) });
    } catch (err) {
      setDeleting(false);
      setError(errorMessage(err));
      return;
    }
    setDeleting(false);
    onDeleted();
  }

  if (!open) return (
    <button onClick={() => setOpen(true)} className="btn btn-ghost btn-sm w-full text-error/70 hover:text-error">
      <Trash2 size={13} />Excluir tabela
    </button>
  );

  return (
    <div className="rounded-xl border border-error/30 bg-error/5 p-3 space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-error"><TriangleAlert size={12} />Zona de perigo</div>
      <p className="text-[11px] text-base-content/65">Digite <span className="font-mono font-semibold">{tableName}</span> para confirmar:</p>
      <input value={confirm} onChange={e => setConfirm(e.target.value)} className="input input-xs w-full" />
      {error && <p className="text-[11px] text-error">{error}</p>}
      <div className="flex gap-2">
        <button onClick={() => { setOpen(false); setConfirm(""); setError(""); }} className="btn btn-ghost btn-xs flex-1">Cancelar</button>
        <button onClick={destroy} disabled={confirm !== tableName || deleting} className="btn btn-error btn-xs flex-1">{deleting ? "..." : "Excluir"}</button>
      </div>
    </div>
  );
}

/** Painel lateral de metadados de uma tabela aberta no workspace (frescor, origem, como usar, histórico, colunas). */
export function MetadataPanel({ table, dataset, projectSlug, publicOrigin, onChanged }: { table: Table; dataset: Dataset; projectSlug: string; publicOrigin: string; onChanged: () => void }) {
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const derived = dataset.derivedTables.find(d => d.targetTable?.id === table.id) ?? null;

  async function refreshSource() {
    if (!table.source && !derived) return;
    setRefreshing(true); setError(""); setNotice("");
    try {
      await apiRequest(table.source ? `/api/v1/dataset-sources/${table.source.id}/refresh` : `/api/v1/derived-tables/${derived!.id}/refresh`, { method: "POST" });
    } catch (err) {
      setRefreshing(false);
      setError(errorMessage(err));
      return;
    }
    setRefreshing(false);
    setNotice("Atualização enfileirada."); onChanged();
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto text-sm">
      {/* Header */}
      <div className="border-b border-base-300 p-4">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-base-content/65">Sobre esta tabela</p>
        <h3 className="mt-1.5 font-semibold leading-tight">{table.name}</h3>
        <p className="mt-0.5 font-mono text-[11px] text-base-content/70">{dataset.schemaName}.{table.sqlName}</p>
      </div>

      {/* Frescor · Origem · Como usar */}
      <FreshnessBlock table={table} derived={derived} />
      <OriginBlock table={table} datasetName={dataset.name} derived={derived} />
      <UsageBlock table={table} dataset={dataset} projectSlug={projectSlug} publicOrigin={publicOrigin} />
      <HistoryBlock tableId={table.id} />

      <div className="flex justify-between gap-3 border-b border-base-300 px-4 py-3 text-xs">
        <span className="text-base-content/70">Colunas</span>
        <span className="font-medium">{table.columns.length}</span>
      </div>

      {/* IDs */}
      <div className="border-b border-base-300 px-3 py-2 space-y-0.5">
        <CopyId label="table" id={table.id} />
        <CopyId label="dataset" id={dataset.id} />
      </div>

      {/* Columns */}
      <div className="flex-1 border-b border-base-300 p-4">
        <p className="mb-2.5 text-[10px] font-semibold uppercase tracking-widest text-base-content/65">Colunas ({table.columns.length})</p>
        <div className="space-y-1.5">
          {table.columns.map((col) => (
            <div key={col.id} className="flex items-center gap-2 text-xs">
              <span className="shrink-0 rounded bg-base-200 px-1 py-0.5 font-mono text-[10px] text-base-content/65 leading-tight">
                {col.sqlType.split("(")[0]}
              </span>
              <span className="truncate text-base-content/75">{col.originalName || col.sqlName}</span>
              {col.nullable && <span className="ml-auto shrink-0 text-[10px] text-base-content/65">null</span>}
            </div>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div className="p-4 space-y-2">
        {notice && <div className="alert alert-success alert-soft text-xs p-2">{notice}</div>}
        {error && <div className="alert alert-error alert-soft text-xs p-2">{error}</div>}
        {(table.source?.mode === "extract" || (!table.source && derived)) && (
          <button
            onClick={refreshSource}
            disabled={refreshing || (!table.source && (derived?.lastStatus === "running" || derived?.lastStatus === "queued"))}
            className="btn btn-outline btn-sm w-full"
          >
            <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} />
            {refreshing ? "Enfileirando..." : "Atualizar agora"}
          </button>
        )}
        {(!table.source || table.source.mode !== "extract") && table.source && (
          <button disabled className="btn btn-outline btn-sm w-full opacity-40 cursor-not-allowed">
            <RefreshCw size={13} />Fonte live
          </button>
        )}
        <DeleteTableButton tableId={table.id} tableName={table.name} onDeleted={onChanged} />
      </div>
    </div>
  );
}
