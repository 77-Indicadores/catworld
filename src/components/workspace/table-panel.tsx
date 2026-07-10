"use client";
import { useEffect, useRef, useState } from "react";
import { Cable, Columns3, DatabaseZap, RefreshCw, Rows3, Trash2, TriangleAlert } from "lucide-react";
import { StatusBadge } from "@/components/ui/primitives";
import { UploadFlow } from "./upload-flow";

type Source = { id: string; mode: string; sourceKind: string; sourceSchema: string | null; sourceTable: string | null; refreshPolicy: string; lastStatus: string | null; lastError: string | null; lastRefreshedAt: string | null; nextRefreshAt: string | null; connection: { name: string } };
type Table = { id: string; name: string; sqlName: string; rowCount: string; lastDataAt: string | null; source: Source | null; columns: { id: string; sqlName: string; originalName: string; sqlType: string; nullable: boolean }[] };

function sourceStatus(status: string | null): "healthy" | "warning" | "error" | "inactive" {
  if (status === "completed" || status === "ready") return "healthy";
  if (status === "failed") return "error";
  if (status === "queued" || status === "running") return "warning";
  return "inactive";
}

function sourceMode(source: Source) {
  return source.mode === "live" ? "Consulta ao vivo" : "Cópia no Catworld";
}

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
            <p className="mt-1 text-xs text-base-content/60">Apaga a tabela e seus dados. Isso não pode ser desfeito.</p>
            <label className="form-control mt-3 w-full"><span className="label-text text-xs">Digite <span className="font-mono font-semibold">{name}</span> para confirmar</span><input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} className="input input-sm mt-1 w-full" /></label>
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
  return <><button onClick={() => ref.current?.showModal()} className="btn btn-outline btn-sm"><RefreshCw size={14} />Atualizar dados</button><dialog ref={ref} className="modal"><div className="modal-box max-w-2xl"><h3 className="text-lg font-bold">Atualizar {table.name}</h3><div className="mt-4"><UploadFlow datasetId={datasetId} targetTable={{ id: table.id, name: table.name }} onComplete={() => { ref.current?.close(); onComplete(); }} /></div><div className="modal-action"><button type="button" onClick={() => ref.current?.close()} className="btn btn-ghost btn-sm">Fechar</button></div></div><form method="dialog" className="modal-backdrop"><button onClick={() => ref.current?.close()}>fechar</button></form></dialog></>;
}

export function TablePanel({ datasetId, table, onChanged }: { datasetId: string; table: Table; onChanged: () => void }) {
  const [tab, setTab] = useState<"data" | "columns">("data");
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const sourceId = table.source?.id;
  const sourceModeValue = table.source?.mode;

  async function refreshSource() {
    if (!table.source) return;
    setRefreshing(true); setError(""); setNotice("");
    const response = await fetch(`/api/v1/dataset-sources/${table.source.id}/refresh`, { method: "POST" });
    setRefreshing(false);
    if (!response.ok) { const body = await response.json().catch(() => ({})); setError(body.error?.message ?? "Falha ao enfileirar atualização"); return; }
    setNotice("Atualização enfileirada. O worker vai processar a fonte.");
    onChanged();
  }

  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => { if (!cancelled) { setLoading(true); setError(""); } });
    const live = sourceModeValue === "live";
    fetch(live ? `/api/v1/dataset-sources/${sourceId}/query` : `/api/v1/tables/${table.id}/rows?limit=100`, live ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ limit: 100 }) } : undefined)
      .then((r) => r.json().then((body) => ({ ok: r.ok, body })))
      .then(({ ok, body }) => { if (cancelled) return; if (!ok) setError(body.error?.message ?? "Falha ao carregar dados"); else setRows(live ? body.data?.rows ?? [] : body.data ?? []); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [table.id, sourceId, sourceModeValue]);

  return (
    <div className="rounded-box border border-base-300 bg-base-100">
      <div className="flex items-start justify-between gap-3 border-b border-base-300 p-5">
        <div>
          <h2 className="font-semibold">{table.name}</h2>
          <p className="text-xs text-base-content/45">{table.source?.mode === "live" ? "Dados consultados na origem" : `${Number(table.rowCount).toLocaleString("pt-BR")} linhas`} · {table.columns.length} colunas{table.lastDataAt ? ` · atualizado ${new Date(table.lastDataAt).toLocaleString("pt-BR")}` : ""}</p>
          {table.source && <div className="mt-3 rounded-box border border-base-300 bg-base-200/40 p-3 text-xs"><div className="flex flex-wrap items-center gap-2"><span className="badge badge-outline gap-1">{table.source.mode === "live" ? <Cable size={12} /> : <DatabaseZap size={12} />}{sourceMode(table.source)}</span><StatusBadge status={sourceStatus(table.source.lastStatus)} label={table.source.lastStatus ?? "Pronta"} /><span className="text-base-content/60">{table.source.connection.name}</span></div><div className="mt-2 text-base-content/60">Origem: {table.source.sourceKind === "table" ? `${table.source.sourceSchema}.${table.source.sourceTable}` : "consulta personalizada"}{table.source.nextRefreshAt ? ` · próxima ${new Date(table.source.nextRefreshAt).toLocaleString("pt-BR")}` : ""}</div></div>}
        </div>
        <div className="flex flex-wrap justify-end gap-2">{table.source?.mode === "extract" ? <button onClick={refreshSource} disabled={refreshing} className="btn btn-outline btn-sm"><RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />{refreshing ? "Enfileirando..." : "Atualizar agora"}</button> : <UpdateDataDialog datasetId={datasetId} table={table} onComplete={onChanged} />}<DeleteTableDialog id={table.id} name={table.name} onDeleted={onChanged} /></div>
      </div>
      {notice && <div className="alert alert-success alert-soft m-4">{notice}</div>}
      {(error || table.source?.lastError) && <div className="alert alert-error alert-soft m-4">{error || table.source?.lastError}</div>}
      <div className="tabs tabs-border px-5">
        <button className={`tab gap-2 ${tab === "data" ? "tab-active" : ""}`} onClick={() => setTab("data")}><Rows3 size={14} />Dados</button>
        <button className={`tab gap-2 ${tab === "columns" ? "tab-active" : ""}`} onClick={() => setTab("columns")}><Columns3 size={14} />Colunas</button>
      </div>
      {tab === "data" ? <div className="overflow-x-auto">{loading ? <div className="p-10 text-center"><span className="loading loading-spinner" /></div> : rows.length === 0 ? <div className="p-10 text-center text-sm text-base-content/50">Nenhuma linha para exibir.</div> : <table className="table table-zebra data-grid"><thead><tr>{table.columns.map((c) => <th key={c.id}>{c.sqlName}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={i}>{table.columns.map((c) => <td className="whitespace-nowrap" key={c.id}>{String(row[c.sqlName] ?? "NULL")}</td>)}</tr>)}</tbody></table>}</div> : <div className="overflow-x-auto"><table className="table"><thead><tr><th>Coluna</th><th>Original</th><th>Tipo</th><th>Nulável</th></tr></thead><tbody>{table.columns.map((c) => <tr key={c.id}><td className="font-mono text-xs">{c.sqlName}</td><td>{c.originalName}</td><td>{c.sqlType}</td><td>{c.nullable ? "Sim" : "Não"}</td></tr>)}</tbody></table></div>}
    </div>
  );
}
