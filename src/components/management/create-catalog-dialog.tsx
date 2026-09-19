"use client";
import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { FormDialog } from "@/components/ui/form-dialog";
import { apiRequest } from "@/lib/api-client";

export function CreateCatalogDialog({ kind, projectId }: { kind: "project" | "dataset"; projectId?: string }) {
  const router = useRouter();

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    const f = new FormData(e.currentTarget);
    await apiRequest(
      kind === "project" ? "/api/v1/projects" : `/api/v1/projects/${projectId}/datasets`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: f.get("name"), description: f.get("description") }) },
    );
    router.refresh();
  }

  return (
    <FormDialog
      trigger={(open) => <button onClick={open} className="btn btn-primary btn-sm"><Plus size={15} />{kind === "project" ? "Novo projeto" : "Novo dataset"}</button>}
      title={kind === "project" ? "Novo projeto" : "Novo dataset"}
      submitLabel="Criar"
      savingLabel="Criando…"
      onSubmit={submit}
    >
      <input name="name" required minLength={2} maxLength={255} placeholder="Nome" className="input w-full" />
      <textarea name="description" maxLength={1000} placeholder="Descrição" className="textarea w-full" />
    </FormDialog>
  );
}
