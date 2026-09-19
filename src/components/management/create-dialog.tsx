"use client";
import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { apiRequest, errorMessage } from "@/lib/api-client";
import { SecretReveal } from "./secret-reveal";
import { useDialog, ModalBackdrop } from "@/components/ui/modal";

type Project = { id: string; name: string; datasets: { id: string; name: string }[] };

export function CreateDialog({ kind, triggerLabel }: { kind: "token" | "database-user"; triggerLabel: string }) {
  const router = useRouter();
  const { ref, open, close: closeDialog } = useDialog();
  const titleId = useId();
  const [projects, setProjects] = useState<Project[]>([]);
  const [scopeType, setScopeType] = useState("GLOBAL");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiRequest<Project[]>("/api/v1/projects").then((r) => setProjects(r.data ?? [])).catch(() => undefined);
  }, []);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    const f = new FormData(e.currentTarget);
    const projectId = String(f.get("projectId") ?? "");
    const datasetId = String(f.get("datasetId") ?? "") || undefined;
    if (scopeType === "PROJECT" && !projectId) { setError("Selecione um projeto."); return; }
    if (scopeType === "DATASET" && !datasetId) { setError("Selecione um dataset."); return; }
    const payload = {
      name: f.get("name"),
      ...(kind === "database-user" ? { kind: f.get("kind") } : { expiresAt: f.get("expiresAt") || null }),
      scopeType,
      projectId: scopeType === "PROJECT" ? projectId : undefined,
      datasetId: scopeType === "DATASET" ? datasetId : undefined,
      permission: f.get("permission"),
    };
    setSaving(true);
    try {
      const { data } = await apiRequest<{ secret: string }>(kind === "token" ? "/api/v1/tokens" : "/api/v1/database-users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      setSecret(data.secret);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  function close() {
    closeDialog();
    setSecret("");
    setScopeType("GLOBAL");
    setError("");
  }

  const showingSecret = secret !== "";

  return (
    <>
      <button className="btn btn-primary btn-sm" onClick={open}>{triggerLabel}</button>
      {/* Com o segredo na tela, Esc e clique fora NÃO fecham: só "Concluir", depois de confirmar que foi guardado. */}
      <dialog ref={ref} className="modal" aria-labelledby={titleId} onCancel={(e) => { if (showingSecret) e.preventDefault(); else close(); }}>
        <div className="modal-box max-w-2xl">
          {showingSecret ? (
            <SecretReveal secret={secret} onDone={close} />
          ) : (
            <form onSubmit={submit}>
              <h3 id={titleId} className="text-lg font-bold">{kind === "token" ? "Criar token" : "Criar usuário SQL"}</h3>
              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <label className="fieldset sm:col-span-2"><span className="fieldset-legend">Nome</span><input name="name" required className="input w-full" /></label>
                {kind === "database-user" && (
                  <label className="fieldset"><span className="fieldset-legend">Tipo</span>
                    <select name="kind" className="select w-full"><option>Power BI</option><option>Aplicação</option><option>Analista</option></select>
                  </label>
                )}
                <label className="fieldset"><span className="fieldset-legend">Permissão</span>
                  <select name="permission" className="select w-full"><option value="READ">Leitura</option><option value="WRITE">Escrita</option></select>
                </label>
                <label className="fieldset"><span className="fieldset-legend">Escopo</span>
                  <select name="scopeType" value={scopeType} onChange={(e) => setScopeType(e.target.value)} className="select w-full">
                    <option value="GLOBAL">Global (todos os datasets)</option><option value="PROJECT">Projeto</option><option value="DATASET">Dataset</option>
                  </select>
                </label>
                {scopeType === "PROJECT" && (
                  <label className="fieldset"><span className="fieldset-legend">Projeto</span>
                    <select name="projectId" required className="select w-full"><option value="">Selecione…</option>{projects.map((p) => <option value={p.id} key={p.id}>{p.name}</option>)}</select>
                  </label>
                )}
                {scopeType === "DATASET" && (
                  <label className="fieldset"><span className="fieldset-legend">Dataset</span>
                    <select name="datasetId" required className="select w-full"><option value="">Selecione…</option>{projects.flatMap((p) => p.datasets.map((d) => <option value={d.id} key={d.id}>{p.name} / {d.name}</option>))}</select>
                  </label>
                )}
                {kind === "token" && (
                  <label className="fieldset"><span className="fieldset-legend">Expiração (opcional)</span><input name="expiresAt" type="datetime-local" className="input w-full" /></label>
                )}
              </div>
              {error && <div role="alert" className="alert alert-error alert-soft mt-4">{error}</div>}
              <div className="modal-action">
                <button type="button" className="btn btn-ghost btn-sm" onClick={close}>Cancelar</button>
                <button className="btn btn-primary btn-sm" disabled={saving}>{saving ? "Criando…" : "Criar acesso"}</button>
              </div>
            </form>
          )}
        </div>
        {!showingSecret && <ModalBackdrop onClose={close} />}
      </dialog>
    </>
  );
}
