"use client";
import { useRef, useState } from "react";
import { Pencil, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { apiErrorText } from "@/lib/api-client";

type Props = { kind: "project" | "dataset"; id: string; name: string; description: string | null; active: boolean };

export function EditCatalogDialog({ kind, id, name, description, active }: Props) {
  const ref = useRef<HTMLDialogElement>(null), router = useRouter();
  const [error, setError] = useState("");
  const [confirmName, setConfirmName] = useState("");
  const [deleting, setDeleting] = useState(false);
  const apiBase = kind === "project" ? "projects" : "datasets";

  function close() { ref.current?.close(); setConfirmName(""); setError(""); }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    const f = new FormData(e.currentTarget);
    const response = await fetch(`/api/v1/${apiBase}/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: f.get("name"), description: f.get("description") || null, active: f.get("active") === "on" }),
    });
    const body = await response.json();
    if (!response.ok) { setError(apiErrorText(body, "Falha ao salvar")); return; }
    close();
    router.refresh();
  }

  async function destroy() {
    setError("");
    setDeleting(true);
    const response = await fetch(`/api/v1/${apiBase}/${id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmName }),
    });
    setDeleting(false);
    if (!response.ok) { const body = await response.json(); setError(apiErrorText(body, "Falha ao excluir")); return; }
    close();
    router.refresh();
  }

  return (
    <>
      <button onClick={() => ref.current?.showModal()} className="btn btn-ghost btn-sm btn-square" aria-label="Editar"><Pencil size={15} /></button>
      <dialog ref={ref} className="modal">
        <div className="modal-box">
          <form onSubmit={submit}>
            <h3 className="text-lg font-bold">{kind === "project" ? "Editar projeto" : "Editar dataset"}</h3>
            <div className="mt-5 space-y-4">
              <input name="name" required minLength={2} maxLength={255} defaultValue={name} placeholder="Nome" className="input w-full" />
              <textarea name="description" maxLength={1000} defaultValue={description ?? ""} placeholder="Descrição" className="textarea w-full" />
              <label className="label cursor-pointer justify-start gap-3"><input type="checkbox" name="active" defaultChecked={active} className="toggle toggle-sm" /><span className="label-text">Ativo</span></label>
            </div>
            <div className="modal-action">
              <button type="button" onClick={close} className="btn btn-ghost btn-sm">Cancelar</button>
              <button className="btn btn-primary btn-sm">Salvar</button>
            </div>
          </form>
          <div className="mt-6 rounded-xl border border-error/30 bg-error/5 p-4">
            <p className="flex items-center gap-2 text-sm font-semibold text-error"><TriangleAlert size={15} />Zona de perigo</p>
            <p className="mt-1 text-xs text-base-content/60">
              {kind === "project" ? "Apaga o projeto, todos os seus datasets, os schemas e tabelas no Azure SQL e os dados associados. Isso não pode ser desfeito." : "Apaga o dataset, suas tabelas, o schema no Azure SQL e os dados associados. Isso não pode ser desfeito."}
            </p>
            <p className="mt-3 text-xs">Digite <span className="font-mono font-semibold">{name}</span> para confirmar:</p>
            <input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} className="input input-sm mt-2 w-full" placeholder={name} />
            <button onClick={destroy} disabled={confirmName !== name || deleting} className="btn btn-error btn-sm mt-3 w-full">{deleting ? "Excluindo..." : "Excluir definitivamente"}</button>
          </div>
          {error && <div className="alert alert-error alert-soft mt-4">{error}</div>}
        </div>
        <form method="dialog" className="modal-backdrop"><button onClick={close}>fechar</button></form>
      </dialog>
    </>
  );
}
