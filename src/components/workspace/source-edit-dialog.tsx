"use client";

import { useRef, useState } from "react";
import { Pencil } from "lucide-react";

type Source = { id: string; name: string; mode: string; refreshPolicy: string };

export function SourceEditDialog({ source, onComplete }: { source: Source; onComplete: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState(source.mode);
  const [policy, setPolicy] = useState(source.refreshPolicy);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  function open() {
    setMode(source.mode);
    setPolicy(source.refreshPolicy);
    setError("");
    ref.current?.showModal();
  }

  async function save() {
    setLoading(true); setError("");
    const response = await fetch(`/api/v1/dataset-sources/${source.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode, refreshPolicy: mode === "live" ? "manual" : policy }),
    });
    setLoading(false);
    if (!response.ok) { const body = await response.json(); setError(body.error?.message ?? "Falha ao salvar"); return; }
    ref.current?.close();
    onComplete();
  }

  return (
    <>
      <button className="btn btn-ghost btn-xs" onClick={open} title="Editar fonte">
        <Pencil size={13} />Editar
      </button>
      <dialog ref={ref} className="modal">
        <div className="modal-box max-w-md">
          <h3 className="text-lg font-bold">Editar fonte</h3>
          <p className="mt-1 text-sm text-base-content/60">{source.name}</p>
          <div className="mt-5 space-y-4">
            <label className="form-control w-full">
              <span className="label-text font-medium">Modo</span>
              <select className="select mt-1 w-full" value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="extract">Copiar para o Catworld</option>
                <option value="live">Consultar direto no Postgres</option>
              </select>
            </label>
            <label className="form-control w-full">
              <span className="label-text font-medium">Atualização automática</span>
              <select className="select mt-1 w-full" disabled={mode === "live"} value={policy} onChange={(e) => setPolicy(e.target.value)}>
                <option value="manual">Manual</option>
                <option value="hourly">A cada hora</option>
                <option value="daily">Diária</option>
                <option value="weekly">Semanal</option>
              </select>
              {mode === "live" && <span className="label-text-alt mt-1 text-base-content/55">Fontes ao vivo sempre consultam a origem na hora — sem agendamento.</span>}
            </label>
          </div>
          {error && <div className="alert alert-error alert-soft mt-4 text-sm">{error}</div>}
          <div className="modal-action">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => ref.current?.close()}>Cancelar</button>
            <button type="button" className="btn btn-primary btn-sm" disabled={loading} onClick={save}>
              {loading ? "Salvando..." : "Salvar alterações"}
            </button>
          </div>
        </div>
        <form method="dialog" className="modal-backdrop"><button>fechar</button></form>
      </dialog>
    </>
  );
}
