"use client";
import { useRef, useState } from "react";
import { ShieldCheck, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";

type Grant = { id: string; scopeType: string; permission: string; project: { name: string } | null; dataset: { name: string; project: { name: string } } | null };
type Project = { id: string; name: string; datasets: { id: string; name: string }[] };

export function ManageGrantsDialog({ userId, userName }: { userId: string; userName: string }) {
  const ref = useRef<HTMLDialogElement>(null), router = useRouter();
  const [grants, setGrants] = useState<Grant[]>([]), [projects, setProjects] = useState<Project[]>([]), [error, setError] = useState("");
  const [scopeType, setScopeType] = useState("GLOBAL");

  async function load() {
    const [g, p] = await Promise.all([
      fetch(`/api/v1/users/${userId}/grants`).then((r) => r.json()),
      fetch("/api/v1/projects").then((r) => r.json()),
    ]);
    setGrants(g.data ?? []);
    setProjects(p.data ?? []);
  }
  function open() { ref.current?.showModal(); void load(); }
  async function revoke(id: string) {
    if (!confirm("Revogar este acesso?")) return;
    await fetch(`/api/v1/users/${userId}/grants/${id}`, { method: "DELETE" });
    await load();
    router.refresh();
  }
  async function add(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    const f = new FormData(e.currentTarget);
    if (scopeType === "PROJECT" && !f.get("projectId")) { setError("Selecione um projeto"); return; }
    if (scopeType === "DATASET" && !f.get("datasetId")) { setError("Selecione um dataset"); return; }
    const response = await fetch(`/api/v1/users/${userId}/grants`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scopeType,
        projectId: scopeType === "PROJECT" ? String(f.get("projectId") ?? "") || undefined : undefined,
        datasetId: scopeType === "DATASET" ? String(f.get("datasetId") ?? "") || undefined : undefined,
        permission: f.get("permission"),
      }),
    });
    if (!response.ok) { const body = await response.json(); setError(body.error?.message ?? "Falha ao conceder acesso"); return; }
    e.currentTarget.reset();
    setScopeType("GLOBAL");
    await load();
    router.refresh();
  }
  return (
    <>
      <button onClick={open} className="btn btn-ghost btn-xs"><ShieldCheck size={13} />Acessos</button>
      <dialog ref={ref} className="modal">
        <div className="modal-box max-w-xl">
          <h3 className="text-lg font-bold">Acessos de {userName}</h3>
          <div className="mt-4 space-y-2">
            {grants.length === 0 && <p className="text-sm text-base-content/55">Nenhum acesso concedido.</p>}
            {grants.map((g) => (
              <div key={g.id} className="flex items-center justify-between rounded-lg bg-base-200 px-3 py-2 text-sm">
                <span>{g.scopeType === "GLOBAL" ? "Global" : g.scopeType === "PROJECT" ? g.project?.name : `${g.dataset?.project.name} / ${g.dataset?.name}`} · {g.permission}</span>
                <button onClick={() => revoke(g.id)} className="btn btn-ghost btn-xs text-error" aria-label="Revogar"><Trash2 size={13} /></button>
              </div>
            ))}
          </div>
          <form onSubmit={add} className="mt-5 grid gap-3 border-t border-base-300 pt-4 sm:grid-cols-2">
            <select name="scopeType" value={scopeType} onChange={(e) => setScopeType(e.target.value)} className="select select-sm w-full"><option value="GLOBAL">Global</option><option value="PROJECT">Projeto</option><option value="DATASET">Dataset</option></select>
            <select name="permission" className="select select-sm w-full"><option value="READ">Leitura</option><option value="WRITE">Escrita</option><option value="ADMIN">Admin</option></select>
            {scopeType === "PROJECT" && <select name="projectId" className="select select-sm w-full"><option value="">Projeto...</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
            {scopeType === "DATASET" && <select name="datasetId" className="select select-sm w-full"><option value="">Dataset...</option>{projects.flatMap((p) => p.datasets.map((d) => <option key={d.id} value={d.id}>{p.name} / {d.name}</option>))}</select>}
            <button className="btn btn-primary btn-sm sm:col-span-2">Conceder acesso</button>
          </form>
          {error && <div className="alert alert-error alert-soft mt-3">{error}</div>}
          <div className="modal-action"><button type="button" onClick={() => ref.current?.close()} className="btn btn-ghost btn-sm">Fechar</button></div>
        </div>
        <form method="dialog" className="modal-backdrop"><button>fechar</button></form>
      </dialog>
    </>
  );
}
