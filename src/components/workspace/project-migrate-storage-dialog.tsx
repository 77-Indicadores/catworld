"use client";
import { useRef, useState } from "react";
import { ArrowLeftRight } from "lucide-react";
import { apiRequest, errorMessage } from "@/lib/api-client";
import type { StorageServerOption, WorkspaceProject as Project } from "@/lib/workspace/types";

/** Agrupa os datasets por servidor atual — um projeto pode estar fragmentado entre vários (ex: migração anterior interrompida). */
function groupByServer(project: Project, storageServers: StorageServerOption[]) {
  const fallbackId = storageServers.find(s => s.isDefault)?.id ?? null;
  const groups = new Map<string, { server: StorageServerOption | undefined; count: number }>();
  for (const d of project.datasets) {
    const id = d.storageServerId ?? fallbackId ?? "unknown";
    const entry = groups.get(id) ?? { server: storageServers.find(s => s.id === id), count: 0 };
    entry.count += 1;
    groups.set(id, entry);
  }
  return [...groups.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.count - a.count);
}

export function ProjectMigrateStorageDialog({ project, storageServers, onChanged }: {
  project: Project; storageServers: StorageServerOption[]; onChanged: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  const serverGroups = groupByServer(project, storageServers);
  const fragmented = serverGroups.length > 1;
  // "Servidor atual" só faz sentido de verdade quando o projeto não está fragmentado; senão usamos
  // o mais comum como sugestão de origem, mas deixamos a fragmentação explícita na tela.
  const dominantServerId = serverGroups[0]?.id ?? null;

  const targetOptions = storageServers.filter(s => s.id !== dominantServerId || fragmented);

  const [targetId, setTargetId] = useState(targetOptions[0]?.id ?? "");
  const [submitting, setSubmitting] = useState(false);
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
    setSubmitting(true); setResult(null); setError(null);
    try {
      const { data } = await apiRequest<{ jobId: string }>(`/api/v1/projects/${project.id}/migrate-storage`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetStorageServerId: targetId }),
      });
      setResult(`Migração iniciada em background (job ${data?.jobId?.slice(0, 8)}…). Acompanhe pelo indicador no topo da tela — pode fechar esta janela.`);
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
      <button className="btn btn-ghost btn-xs gap-1" onClick={open} title="Migrar projeto para outro servidor SQL">
        <ArrowLeftRight size={13} />
      </button>
      <dialog ref={dialogRef} className="modal">
        <div className="modal-box max-w-md">
          <h3 className="font-bold text-base">Migrar projeto</h3>
          <p className="mt-0.5 text-xs text-base-content/65">Move os datasets de <strong>{project.name}</strong> para outro servidor de armazenamento. Roda em background — você pode fechar esta janela a qualquer momento.</p>

          <div className="mt-4 space-y-3">
            {fragmented ? (
              <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs">
                <p className="font-medium text-warning">Este projeto está dividido entre servidores</p>
                <ul className="mt-1 space-y-0.5 text-base-content/70">
                  {serverGroups.map(g => (
                    <li key={g.id}>{g.count} dataset(s) em <strong>{g.server?.name ?? "servidor desconhecido"}</strong></li>
                  ))}
                </ul>
                <p className="mt-1 text-base-content/70">A migração abaixo move todos os datasets que ainda não estão no destino escolhido.</p>
              </div>
            ) : (
              <div className="text-xs text-base-content/65">
                Servidor atual: <span className="font-medium text-base-content/70">{serverGroups[0]?.server?.name ?? "Servidor padrão"}</span>
              </div>
            )}
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
                <li>Os dados originais <em>não</em> serão removidos do servidor de origem</li>
                <li>Só troca os datasets de servidor depois que TODOS forem copiados com sucesso — se algo falhar no meio, nada muda</li>
                <li>Pode demorar para projetos com muitos dados; acompanhe pelo indicador no topo da tela</li>
              </ul>
            </div>

            {result && <div className="alert alert-success text-sm">{result}</div>}
            {error && <div className="alert alert-error text-sm">{error}</div>}
          </div>

          <div className="modal-action">
            <button className="btn btn-ghost btn-sm" onClick={close} disabled={submitting}>{result ? "Fechar" : "Cancelar"}</button>
            {!result && (
              <button className="btn btn-warning btn-sm" onClick={() => { void migrate(); }} disabled={submitting}>
                {submitting ? <><span className="loading loading-spinner loading-xs" />Iniciando…</> : "Migrar projeto"}
              </button>
            )}
          </div>
        </div>
        <form method="dialog" className="modal-backdrop"><button onClick={close}>fechar</button></form>
      </dialog>
    </>
  );
}
