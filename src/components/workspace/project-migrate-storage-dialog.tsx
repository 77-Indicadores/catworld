"use client";
import { useRef, useState } from "react";
import { Server } from "lucide-react";
import { apiRequest, errorMessage } from "@/lib/api-client";
import type { StorageServerOption, WorkspaceProject as Project } from "@/lib/workspace/types";

export function ProjectMigrateStorageDialog({ project, storageServers, onChanged }: {
  project: Project; storageServers: StorageServerOption[]; onChanged: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Servidor atual do projeto: storageServerId do primeiro dataset, ou o isDefault
  const currentServerId = project.datasets[0]?.storageServerId
    ?? storageServers.find(s => s.isDefault)?.id
    ?? null;
  const currentServer = storageServers.find(s => s.id === currentServerId);

  // Servidores disponíveis como destino (exclui o atual)
  const targetOptions = storageServers.filter(s => s.id !== currentServerId);

  const [targetId, setTargetId] = useState(targetOptions[0]?.id ?? "");
  const [migrating, setMigrating] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (storageServers.length < 2) return null;

  function open() {
    setTargetId(targetOptions[0]?.id ?? "");
    setResult(null); setError(null);
    dialogRef.current?.showModal();
  }
  function close() { dialogRef.current?.close(); }

  async function migrate() {
    setMigrating(true); setResult(null); setError(null);
    try {
      const { data } = await apiRequest<{ datasetsMigrated: number }>(`/api/v1/projects/${project.id}/migrate-storage`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetStorageServerId: targetId }),
      });
      setResult(`✓ ${data?.datasetsMigrated ?? 0} dataset(s) migrado(s) com sucesso`);
      setMigrating(false);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
      setMigrating(false);
    }
  }

  const target = storageServers.find(s => s.id === targetId);

  return (
    <>
      <button className="btn btn-ghost btn-xs gap-1" onClick={open} title="Migrar projeto para outro servidor SQL">
        <Server size={13} />
      </button>
      <dialog ref={dialogRef} className="modal">
        <div className="modal-box max-w-md">
          <h3 className="font-bold text-base">Migrar projeto</h3>
          <p className="mt-0.5 text-xs text-base-content/65">Move todos os datasets de <strong>{project.name}</strong> para outro servidor de armazenamento.</p>

          <div className="mt-4 space-y-3">
            <div className="text-xs text-base-content/65">
              Servidor atual: <span className="font-medium text-base-content/70">{currentServer?.name ?? "Servidor padrão"}</span>
            </div>
            <label className="form-control w-full">
              <span className="label-text font-medium">Servidor de destino</span>
              <select className="select mt-1 w-full" value={targetId} onChange={e => setTargetId(e.target.value)}>
                {targetOptions.map(s => (
                  <option key={s.id} value={s.id}>{s.name}{s.isDefault ? " (padrão)" : ""}</option>
                ))}
              </select>
            </label>

            <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-base-content/70">
              <p className="font-medium text-warning">Atenção</p>
              <ul className="mt-1 list-disc list-inside space-y-0.5">
                <li>Todas as tabelas serão copiadas para <strong>{target?.name}</strong></li>
                <li>Os dados originais <em>não</em> serão removidos do servidor atual</li>
                <li>Pode demorar para projetos com muitos dados</li>
              </ul>
            </div>

            {result && <div className="alert alert-success text-sm">{result}</div>}
            {error && <div className="alert alert-error text-sm">{error}</div>}
          </div>

          <div className="modal-action">
            <button className="btn btn-ghost btn-sm" onClick={close} disabled={migrating}>Cancelar</button>
            <button className="btn btn-warning btn-sm" onClick={() => { void migrate(); }} disabled={migrating}>
              {migrating ? <><span className="loading loading-spinner loading-xs" />Migrando…</> : "Migrar projeto"}
            </button>
          </div>
        </div>
        <form method="dialog" className="modal-backdrop"><button onClick={close}>fechar</button></form>
      </dialog>
    </>
  );
}
