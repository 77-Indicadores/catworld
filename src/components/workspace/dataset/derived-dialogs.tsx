"use client";
import { useRef, useState } from "react";
import { Pencil, Plus } from "lucide-react";
import { apiErrorText } from "@/lib/api-client";
import { CronPreview } from "../cron-field";
import type { WorkspaceDerived as DerivedTable } from "@/lib/workspace/types";

export function DerivedCreateDialog({ datasetId, onComplete }: { datasetId: string; onComplete: () => void }) {
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
    if (!r.ok) { const b = await r.json().catch(() => ({})); setError(apiErrorText(b, "Erro ao criar")); return; }
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
              {refreshCron.trim() ? <CronPreview cron={refreshCron} onPick={setRefreshCron} /> : (
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

export function DerivedEditDialog({ dt, onComplete }: { dt: DerivedTable; onComplete: () => void }) {
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
    if (!r.ok) { const b = await r.json().catch(() => ({})); setError(apiErrorText(b, "Erro ao salvar")); return; }
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
              {refreshCron.trim() ? <CronPreview cron={refreshCron} onPick={setRefreshCron} /> : (
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
