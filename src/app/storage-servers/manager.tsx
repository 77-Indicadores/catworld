"use client";

import { useState, useTransition } from "react";
import { CheckCircle2, CircleX, Clock3, Database, Pencil, Plus, RefreshCw, Star, Trash2, Wifi } from "lucide-react";

type Server = {
  id: string;
  name: string;
  provider: string;
  url: string | null;
  isDefault: boolean;
  active: boolean;
  lastStatus: string | null;
  lastLatencyMs: number | null;
  lastCheckedAt: Date | string | null;
  _count: { datasets: number };
};

type TestResult = { healthy: boolean; latencyMs: number; database: string } | { error: string };

function statusBadge(s: Server) {
  if (!s.active) return <span className="badge badge-sm badge-ghost gap-1"><Clock3 size={11} />Inativo</span>;
  if (s.lastStatus === "healthy") return <span className="badge badge-sm badge-success gap-1"><CheckCircle2 size={11} />{s.lastLatencyMs}ms</span>;
  if (s.lastStatus === "error") return <span className="badge badge-sm badge-error gap-1"><CircleX size={11} />Erro</span>;
  return <span className="badge badge-sm badge-ghost gap-1"><Clock3 size={11} />Não testado</span>;
}

function maskedUrl(url: string | null) {
  if (!url) return "—";
  try {
    return url.replace(/password=[^;]+/i, "password=••••••••");
  } catch {
    return url;
  }
}

export function StorageServerManager({ initialServers }: { initialServers: Server[] }) {
  const [servers, setServers] = useState(initialServers);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Server | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [formName, setFormName] = useState("");
  const [formUrl, setFormUrl] = useState("");
  const [formDefault, setFormDefault] = useState(false);
  const [formProvider, setFormProvider] = useState<"sqlserver" | "postgres">("sqlserver");

  function openCreate() {
    setEditing(null);
    setFormName("");
    setFormUrl("");
    setFormDefault(false);
    setFormProvider("sqlserver");
    setError(null);
    setModalOpen(true);
  }

  function openEdit(s: Server) {
    setEditing(s);
    setFormName(s.name);
    setFormUrl(s.url ?? "");
    setFormDefault(s.isDefault);
    setFormProvider((s.provider as "sqlserver" | "postgres") ?? "sqlserver");
    setError(null);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditing(null);
    setError(null);
  }

  async function reload() {
    const res = await fetch("/api/v1/storage-servers");
    const json = await res.json() as { data: Server[] };
    setServers(json.data ?? []);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const body = { name: formName.trim(), url: formUrl.trim(), isDefault: formDefault, provider: formProvider };
    startTransition(async () => {
      try {
        const res = await fetch(
          editing ? `/api/v1/storage-servers/${editing.id}` : "/api/v1/storage-servers",
          { method: editing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
        );
        const json = await res.json() as { error?: { message: string } };
        if (!res.ok) { setError(json.error?.message ?? "Erro desconhecido"); return; }
        closeModal();
        await reload();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Erro de rede");
      }
    });
  }

  async function handleDelete(s: Server) {
    if (!confirm(`Remover "${s.name}"? Esta ação não pode ser desfeita.`)) return;
    const res = await fetch(`/api/v1/storage-servers/${s.id}`, { method: "DELETE" });
    const json = await res.json() as { error?: { message: string } };
    if (!res.ok) { alert(json.error?.message ?? "Erro ao remover"); return; }
    await reload();
  }

  async function handleTest(s: Server) {
    setTesting(s.id);
    try {
      const res = await fetch(`/api/v1/storage-servers/${s.id}/test`, { method: "POST" });
      const json = await res.json() as { data?: { healthy: boolean; latencyMs: number; database: string }; error?: { message: string } };
      if (!res.ok || !json.data) {
        setTestResults((p) => ({ ...p, [s.id]: { error: json.error?.message ?? "Falha na conexão" } }));
      } else {
        setTestResults((p) => ({ ...p, [s.id]: json.data! }));
      }
      await reload();
    } catch (err) {
      setTestResults((p) => ({ ...p, [s.id]: { error: err instanceof Error ? err.message : "Erro de rede" } }));
    } finally {
      setTesting(null);
    }
  }

  async function handleSetDefault(s: Server) {
    const res = await fetch(`/api/v1/storage-servers/${s.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isDefault: true }),
    });
    if (!res.ok) { const j = await res.json() as { error?: { message: string } }; alert(j.error?.message ?? "Erro"); return; }
    await reload();
  }

  return (
    <>
      {/* Header row */}
      <div className="flex items-center justify-between gap-3 px-5 py-4">
        <span className="text-sm text-base-content/60">{servers.length} servidor{servers.length !== 1 ? "es" : ""}</span>
        <button className="btn btn-sm btn-primary gap-2" onClick={openCreate}>
          <Plus size={15} />Adicionar servidor
        </button>
      </div>

      {/* Table */}
      {servers.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-base-content/50">
          <Database size={36} />
          <p className="text-sm">Nenhum servidor cadastrado</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr className="border-t border-base-300 text-xs uppercase tracking-wide text-base-content/45">
                <th>Nome</th>
                <th>URL</th>
                <th className="text-center">Datasets</th>
                <th className="text-center">Status</th>
                <th className="text-right">Ações</th>
              </tr>
            </thead>
            <tbody>
              {servers.map((s) => {
                const tr = testResults[s.id];
                return (
                  <tr key={s.id} className="border-t border-base-300">
                    <td>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{s.name}</span>
                        {s.isDefault && <span className="badge badge-xs badge-primary">padrão</span>}
                        {!s.active && <span className="badge badge-xs badge-ghost">inativo</span>}
                        <span className={`badge badge-xs ${s.provider === "postgres" ? "badge-info" : "badge-warning"}`}>
                          {s.provider === "postgres" ? "PG" : "MSSQL"}
                        </span>
                      </div>
                    </td>
                    <td className="max-w-xs truncate font-mono text-xs text-base-content/60">{maskedUrl(s.url)}</td>
                    <td className="text-center text-sm">{s._count.datasets}</td>
                    <td className="text-center">
                      {tr && "error" in tr
                        ? <span className="badge badge-sm badge-error gap-1"><CircleX size={11} />{tr.error}</span>
                        : tr && "healthy" in tr
                        ? <span className="badge badge-sm badge-success gap-1"><CheckCircle2 size={11} />{tr.latencyMs}ms · {tr.database}</span>
                        : statusBadge(s)}
                    </td>
                    <td>
                      <div className="flex items-center justify-end gap-1">
                        <button
                          className="btn btn-xs btn-ghost gap-1"
                          onClick={() => handleTest(s)}
                          disabled={testing === s.id}
                          title="Testar conexão"
                        >
                          {testing === s.id
                            ? <RefreshCw size={13} className="animate-spin" />
                            : <Wifi size={13} />}
                          Testar
                        </button>
                        {!s.isDefault && (
                          <button className="btn btn-xs btn-ghost" onClick={() => handleSetDefault(s)} title="Tornar padrão">
                            <Star size={13} />
                          </button>
                        )}
                        <button className="btn btn-xs btn-ghost" onClick={() => openEdit(s)} title="Editar">
                          <Pencil size={13} />
                        </button>
                        {!s.isDefault && (
                          <button className="btn btn-xs btn-ghost text-error" onClick={() => handleDelete(s)} title="Remover">
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral/40 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg rounded-box border border-base-300 bg-base-100 shadow-2xl">
            <div className="flex items-center justify-between border-b border-base-300 px-6 py-4">
              <h2 className="font-semibold">{editing ? "Editar servidor" : "Adicionar servidor"}</h2>
              <button className="btn btn-ghost btn-sm btn-square" onClick={closeModal}>✕</button>
            </div>

            <form onSubmit={(e) => { void handleSubmit(e); }} className="p-6 space-y-4">
              <div className="form-control">
                <label className="label"><span className="label-text font-medium">Nome</span></label>
                <input
                  className="input input-sm input-bordered w-full"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder={formProvider === "postgres" ? "ex: PostgreSQL – Produção" : "ex: Azure SQL Server – Produção"}
                  required
                />
              </div>

              <div className="form-control">
                <label className="label"><span className="label-text font-medium">Provider</span></label>
                <select
                  className="select select-sm select-bordered w-full"
                  value={formProvider}
                  onChange={(e) => setFormProvider(e.target.value as "sqlserver" | "postgres")}
                  disabled={!!editing}
                >
                  <option value="sqlserver">SQL Server (MSSQL)</option>
                  <option value="postgres">PostgreSQL</option>
                </select>
                {editing && <label className="label"><span className="label-text-alt text-base-content/45">Provider não pode ser alterado após criação.</span></label>}
              </div>

              <div className="form-control">
                <label className="label">
                  <span className="label-text font-medium">URL de conexão</span>
                  <span className="label-text-alt text-base-content/50">{formProvider === "postgres" ? "PostgreSQL" : "SQL Server"}</span>
                </label>
                <textarea
                  className="textarea textarea-bordered textarea-sm w-full font-mono text-xs leading-relaxed"
                  rows={3}
                  value={formUrl}
                  onChange={(e) => setFormUrl(e.target.value)}
                  placeholder={formProvider === "postgres"
                    ? "postgres://user:password@host:5432/database?sslmode=require"
                    : "sqlserver://host:1433;database=...;user=...;password=...;encrypt=true"}
                  required
                />
                <label className="label">
                  <span className="label-text-alt text-base-content/45">A URL é criptografada antes de ser salva.</span>
                </label>
              </div>

              <div className="form-control">
                <label className="label cursor-pointer justify-start gap-3">
                  <input
                    type="checkbox"
                    className="checkbox checkbox-sm checkbox-primary"
                    checked={formDefault}
                    onChange={(e) => setFormDefault(e.target.checked)}
                  />
                  <span className="label-text">Definir como servidor padrão</span>
                </label>
              </div>

              {error && (
                <div className="alert alert-error alert-sm text-sm">{error}</div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button type="button" className="btn btn-sm btn-ghost" onClick={closeModal}>Cancelar</button>
                <button type="submit" className="btn btn-sm btn-primary" disabled={isPending}>
                  {isPending ? <span className="loading loading-spinner loading-xs" /> : null}
                  {editing ? "Salvar" : "Adicionar"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
