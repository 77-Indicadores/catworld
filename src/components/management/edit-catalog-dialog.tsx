"use client";
import { useState } from "react";
import { Pencil } from "lucide-react";
import { useRouter } from "next/navigation";
import { apiRequest, errorMessage } from "@/lib/api-client";
import { DangerZone } from "@/components/ui/danger-zone";
import { useDialog, ModalBackdrop } from "@/components/ui/modal";

type Props = { kind: "project" | "dataset"; id: string; name: string; description: string | null; active: boolean };

export function EditCatalogDialog({ kind, id, name, description, active }: Props) {
  const { ref, open, close: closeDialog } = useDialog();
  const router = useRouter();
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const apiBase = kind === "project" ? "projects" : "datasets";

  function close() { closeDialog(); setError(""); }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    const f = new FormData(e.currentTarget);
    try {
      await apiRequest(`/api/v1/${apiBase}/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: f.get("name"), description: f.get("description") || null, active: f.get("active") === "on" }),
      });
    } catch (err) {
      setError(errorMessage(err));
      return;
    }
    close();
    router.refresh();
  }

  async function destroy() {
    setError("");
    setDeleting(true);
    try {
      await apiRequest(`/api/v1/${apiBase}/${id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmName: name }),
      });
    } catch (err) {
      setDeleting(false);
      setError(errorMessage(err));
      return;
    }
    setDeleting(false);
    close();
    router.refresh();
  }

  return (
    <>
      <button onClick={open} className="btn btn-ghost btn-sm btn-square" aria-label="Editar"><Pencil size={15} /></button>
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
          <DangerZone
            description={kind === "project" ? "Apaga o projeto, todos os seus datasets, os schemas e tabelas no Azure SQL e os dados associados. Isso não pode ser desfeito." : "Apaga o dataset, suas tabelas, o schema no Azure SQL e os dados associados. Isso não pode ser desfeito."}
            confirmValue={name}
            confirmLabel="Excluir definitivamente"
            busyLabel="Excluindo..."
            busy={deleting}
            onConfirm={destroy}
          />
          {error && <div className="alert alert-error alert-soft mt-4">{error}</div>}
        </div>
        <ModalBackdrop onClose={close} />
      </dialog>
    </>
  );
}
