"use client";
import { useRef, useState } from "react";
import { ArrowLeftRight } from "lucide-react";
import { apiRequest, errorMessage } from "@/lib/api-client";
import type { StorageServerOption, WorkspaceDataset as Dataset } from "@/lib/workspace/types";

/** Migração de um único dataset — mesmo job (MIGRATE_STORAGE_DATASET) usado pela migração de projeto, só que para um dataset. */
export function DatasetMigrateStorageDialog({ dataset, storageServers, onChanged }: {
  dataset: Dataset; storageServers: StorageServerOption[]; onChanged: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const currentServerId = dataset.storageServerId ?? storageServers.find(s => s.isDefault)?.id ?? null;
  const targetOptions = storageServers.filter(s => s.id !== currentServerId);

  const [targetId, setTargetId] = useState(targetOptions[0]?.id ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (storageServers.length < 2 || targetOptions.length === 0) return null;

  function open() {
    setTargetId(targetOptions[0]?.id ?? "");
    setResult(null); setError(null);
    dialogRef.current?.showModal();
  }
  function close() { dialogRef.current?.close(); }

  async function migrate() {
    setSubmitting(true); setResult(null); setError(null);
    try {
      const { data } = await apiRequest<{ jobId: string }>(`/api/v1/datasets/${dataset.id}/migrate-storage`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetStorageServerId: targetId }),
      });
      setResult(`Migração iniciada em background (job ${data?.jobId?.slice(0, 8)}…). Acompanhe pelo indicador no topo da tela.`);
      setSubmitting(false);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
      setSubmitting(false);
    }
  }

  const target = storageServers.find(s => s.id === targetId);

  return (
    <>
      <button className="btn btn-ghost btn-xs btn-square" onClick={open} title="Migrar este dataset para outro servidor">
        <ArrowLeftRight size={11} />
      </button>
      <dialog ref={dialogRef} className="modal">
        <div className="modal-box max-w-sm">
          <h3 className="font-bold text-base">Migrar dataset</h3>
          <p className="mt-0.5 text-xs text-base-content/65">Move <strong>{dataset.name}</strong> para outro servidor de armazenamento. Roda em background.</p>

          <div className="mt-4 space-y-3">
            <label className="form-control w-full">
              <span className="label-text font-medium">Servidor de destino</span>
              <select className="select mt-1 w-full" value={targetId} onChange={e => setTargetId(e.target.value)}>
                {targetOptions.map(s => (
                  <option key={s.id} value={s.id}>{s.name}{s.isDefault ? " (padrão)" : ""}</option>
                ))}
              </select>
            </label>
            <p className="text-xs text-base-content/65">
              Copia todas as tabelas de <strong>{dataset.name}</strong> para <strong>{target?.name}</strong>. Os dados originais não são removidos.
            </p>
            {result && <div className="alert alert-success text-xs">{result}</div>}
            {error && <div className="alert alert-error text-xs">{error}</div>}
          </div>

          <div className="modal-action">
            <button className="btn btn-ghost btn-sm" onClick={close} disabled={submitting}>{result ? "Fechar" : "Cancelar"}</button>
            {!result && (
              <button className="btn btn-warning btn-sm" onClick={() => { void migrate(); }} disabled={submitting}>
                {submitting ? <><span className="loading loading-spinner loading-xs" />Iniciando…</> : "Migrar"}
              </button>
            )}
          </div>
        </div>
        <form method="dialog" className="modal-backdrop"><button onClick={close}>fechar</button></form>
      </dialog>
    </>
  );
}
