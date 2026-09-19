"use client";
import { useState } from "react";
import { Pencil } from "lucide-react";
import { useRouter } from "next/navigation";
import { apiRequest, errorMessage } from "@/lib/api-client";
import { DangerZone } from "@/components/ui/danger-zone";
import { FormDialog } from "@/components/ui/form-dialog";

type Props = { kind: "project" | "dataset"; id: string; name: string; description: string | null; active: boolean };

export function EditCatalogDialog({ kind, id, name, description, active }: Props) {
  const router = useRouter();
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const apiBase = kind === "project" ? "projects" : "datasets";

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    const f = new FormData(e.currentTarget);
    await apiRequest(`/api/v1/${apiBase}/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: f.get("name"), description: f.get("description") || null, active: f.get("active") === "on" }),
    });
    router.refresh();
  }

  async function destroy(close: () => void) {
    setDeleteError("");
    setDeleting(true);
    try {
      await apiRequest(`/api/v1/${apiBase}/${id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmName: name }),
      });
    } catch (err) {
      setDeleting(false);
      setDeleteError(errorMessage(err));
      return;
    }
    setDeleting(false);
    close();
    router.refresh();
  }

  return (
    <FormDialog
      trigger={(open) => <button onClick={open} className="btn btn-ghost btn-sm btn-square" aria-label="Editar"><Pencil size={15} /></button>}
      title={kind === "project" ? "Editar projeto" : "Editar dataset"}
      submitLabel="Salvar"
      onSubmit={submit}
      afterForm={(close) => (
        <DangerZone
          description={kind === "project" ? "Apaga o projeto, todos os seus datasets, os schemas e tabelas no Azure SQL e os dados associados. Isso não pode ser desfeito." : "Apaga o dataset, suas tabelas, o schema no Azure SQL e os dados associados. Isso não pode ser desfeito."}
          confirmValue={name}
          confirmLabel="Excluir definitivamente"
          busyLabel="Excluindo..."
          busy={deleting}
          error={deleteError}
          onConfirm={() => destroy(close)}
        />
      )}
    >
      <input name="name" required minLength={2} maxLength={255} defaultValue={name} placeholder="Nome" className="input w-full" />
      <textarea name="description" maxLength={1000} defaultValue={description ?? ""} placeholder="Descrição" className="textarea w-full" />
      <label className="label cursor-pointer justify-start gap-3"><input type="checkbox" name="active" defaultChecked={active} className="toggle toggle-sm" /><span className="label-text">Ativo</span></label>
    </FormDialog>
  );
}
