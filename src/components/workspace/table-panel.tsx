"use client";
import { useEffect, useRef, useState } from "react";
import { Cable, Columns3, DatabaseZap, RefreshCw, Rows3, Trash2, TriangleAlert } from "lucide-react";
import { UploadFlow } from "./upload-flow";

type Source = { id: string; mode: string; sourceKind: string; sourceSchema: string | null; sourceTable: string | null; refreshPolicy: string; lastStatus: string | null; lastError: string | null; lastRefreshedAt: string | null; nextRefreshAt: string | null; connection: { name: string } };
type Table = { id: string; name: string; sqlName: string; rowCount: string; source: Source | null; columns: { id: string; sqlName: string; originalName: string; sqlType: string; nullable: boolean }[] };

function DeleteTableDialog({ id, name, onDeleted }: { id: string; name: string; onDeleted: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [confirmName, setConfirmName] = useState(""), [deleting, setDeleting] = useState(false), [error, setError] = useState("");
  function close() { ref.current?.close(); setConfirmName(""); setError(""); }
  async function destroy() {
    setDeleting(true); setError("");
    const response = await fetch(`/api/v1/tables/${id}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmName }) });
    setDeleting(false);
    if (!response.ok) { const body = await response.json(); setError(body.error?.message ?? "Falha ao excluir"); return; }
    close(); onDeleted();
  }
  return (
    <>
      <button onClick={() => ref.current?.showModal()} className="btn btn-ghost btn-sm text-error"><Trash2 size={14} />Excluir tabela</button>
      <dialog ref={ref} className="modal">
        <div className="modal-box">
          <div className="rounded-xl border border-error/30 bg-error/5 p-4">
            <p className="flex items-center gap-2 text-sm font-semibold text-error"><TriangleAlert size={15} />Zona de perigo</p>
            <p className="mt-1 text-xs text-base-content/60">Apaga a tabela e seus dados no Azure SQL. Isso nao pode ser desfeito.</p>
            <p className="mt-3 text-xs">Digite <span className="font-mono font-semibold">{name}</span> para confirmar:</p>
            <input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} className="input input-sm mt-2 w-full" placeholder={name} />
            <button onClick={destroy} disabled={confirmName !== name || deleting} className="btn btn-error btn-sm mt-3 w-full">{deleting ? "Excluindo..." : "Excluir definitivamente"}</button>
          </div>
          {error && <div className="alert alert-error alert-soft mt-4">{error}</div>}
          <div className="modal-action"><button type="button" onClick={close} className="btn btn-ghost btn-sm">Fechar</button></div>
        </div>
        <form method="dialog" className="modal-backdrop"><button onClick={close}>fechar</button></form>
      </dialog>
    </>
  );
}

function UpdateDataDialog({ datasetId, table, onComplete }: { datasetId: string; table: Table; onComplete: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button onClick={() => ref.current?.showModal()} className="btn btn-outline btn-sm"><RefreshCw size={14} />Atualizar dados</button>
      <dialog ref={ref} className="modal">
        <div className="modal-box max-w-2xl">
          <h3 className="text-lg font-bold">Atualizar {table.name}</h3>
          <div className="mt-4"><UploadFlow datasetId={datasetId} targetTable={{ id: table.id, name: table.name }} onComplete={() => { ref.current?.close(); onComplete(); }} /></div>
          <div className="modal-action"><button type="button" onClick={() => ref.current?.close()} className="btn btn-ghost btn-sm">Fechar</button></div>
        </div>
        <form method="dialog" className="modal-backdrop"><button onClick={() => ref.current?.close()}>fechar</button></form>
      </dialog>
    </>
  );
}

export function TablePanel({ datasetId, table, onChanged }: { datasetId: string; table: Table; onChanged: () => void }) {
  const [tab, setTab] = useState<"data" | "columns">("data");
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const sourceId = table.source?.id;
  const sourceMode = table.source?.mode;

  async function refreshSource() {
    if (!table.source) return;
    await fetch(`/api/v1/dataset-sources/${table.source.id}/refresh`, { method: "POST" });
    onChanged();
  }

  useEffect(() => {
    const live = sourceMode === "live";
    fetch(live ? `/api/v1/dataset-sources/${sourceId}/query` : `/api/v1/tables/${table.id}/rows?limit=100`, live ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ limit: 100 }) } : undefined)
      .then((r) => r.json())
      .then((body) => setRows(live ? body.data?.rows ?? [] : body.data ?? []))
      .finally(() => setLoading(false));
  }, [table.id, sourceId, sourceMode]);

  return (
    <div className="rounded-box border border-base-300 bg-base-100">
      <div className="flex items-start justify-between gap-3 border-b border-base-300 p-5">
        <div>
          <h2 className="font-semibold">{table.name}</h2>
          <p className="text-xs text-base-content/45">{Number(table.rowCount).toLocaleString("pt-BR")} linhas · {table.columns.length} colunas</p>
          {table.source && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <span className={`badge ${table.source.mode === "live" ? "badge-info" : "badge-success"} gap-1`}>{table.source.mode === "live" ? <Cable size={12} /> : <DatabaseZap size={12} />} {table.source.mode}</span>
              <span className="text-base-content/55">{table.source.connection.name}</span>
              <span className="text-base-content/45">{table.source.lastStatus ?? "ready"}</span>
              {table.source.lastRefreshedAt && <span className="text-base-content/45">Atualizada {new Date(table.source.lastRefreshedAt).toLocaleString("pt-BR")}</span>}
            </div>
          )}
        </div>
        <div className="flex gap-2">
          {table.source?.mode === "extract" ? <button onClick={refreshSource} className="btn btn-outline btn-sm"><RefreshCw size={14} />Atualizar agora</button> : <UpdateDataDialog datasetId={datasetId} table={table} onComplete={onChanged} />}
          <DeleteTableDialog id={table.id} name={table.name} onDeleted={onChanged} />
        </div>
      </div>
      {table.source?.lastError && <div className="alert alert-error alert-soft m-4">{table.source.lastError}</div>}
      <div className="tabs tabs-border px-5">
        <button className={`tab gap-2 ${tab === "data" ? "tab-active" : ""}`} onClick={() => setTab("data")}><Rows3 size={14} />Dados</button>
        <button className={`tab gap-2 ${tab === "columns" ? "tab-active" : ""}`} onClick={() => setTab("columns")}><Columns3 size={14} />Colunas</button>
      </div>
      {tab === "data" ? (
        <div className="overflow-x-auto">
          {loading ? <div className="p-10 text-center"><span className="loading loading-spinner" /></div> : (
            <table className="table table-zebra data-grid"><thead><tr>{table.columns.map((c) => <th key={c.id}>{c.sqlName}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={i}>{table.columns.map((c) => <td className="whitespace-nowrap" key={c.id}>{String(row[c.sqlName] ?? "NULL")}</td>)}</tr>)}</tbody></table>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto"><table className="table"><thead><tr><th>Coluna</th><th>Original</th><th>Tipo</th><th>Nulavel</th></tr></thead><tbody>{table.columns.map((c) => <tr key={c.id}><td className="font-mono text-xs">{c.sqlName}</td><td>{c.originalName}</td><td>{c.sqlType}</td><td>{c.nullable ? "Sim" : "Nao"}</td></tr>)}</tbody></table></div>
      )}
    </div>
  );
}
