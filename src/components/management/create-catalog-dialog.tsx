"use client";
import { useState } from "react";
import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useDialog, ModalBackdrop } from "@/components/ui/modal";

export function CreateCatalogDialog({ kind, projectId }: { kind: "project" | "dataset"; projectId?: string }) {
  const { ref, open, close } = useDialog();
  const router = useRouter();
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const response = await fetch(
      kind === "project" ? "/api/v1/projects" : `/api/v1/projects/${projectId}/datasets`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: f.get("name"), description: f.get("description") }) },
    );
    const body = await response.json();
    if (!response.ok) { setError(body.error?.message ?? "Falha ao criar"); return; }
    close();
    router.refresh();
  }

  return (
    <>
      <button onClick={open} className="btn btn-primary btn-sm"><Plus size={15} />{kind === "project" ? "Novo projeto" : "Novo dataset"}</button>
      <dialog ref={ref} className="modal">
        <form onSubmit={submit} className="modal-box">
          <h3 className="text-lg font-bold">{kind === "project" ? "Novo projeto" : "Novo dataset"}</h3>
          <div className="mt-5 space-y-4">
            <input name="name" required minLength={2} maxLength={255} placeholder="Nome" className="input w-full" />
            <textarea name="description" maxLength={1000} placeholder="Descrição" className="textarea w-full" />
          </div>
          {error && <div className="alert alert-error alert-soft mt-4">{error}</div>}
          <div className="modal-action">
            <button type="button" onClick={close} className="btn btn-ghost btn-sm">Cancelar</button>
            <button className="btn btn-primary btn-sm">Criar</button>
          </div>
        </form>
        <ModalBackdrop onClose={close} />
      </dialog>
    </>
  );
}
