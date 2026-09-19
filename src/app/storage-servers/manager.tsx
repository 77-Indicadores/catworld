"use client";

import { useState, useTransition } from "react";
import { CheckCircle2, CircleX, Clock3, Database, Pencil, Plus, RefreshCw, Star, Trash2, Wifi } from "lucide-react";
import { useApiAction } from "@/components/ui/feedback";
import { DangerZone } from "@/components/ui/danger-zone";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { useDialog, ModalBackdrop } from "@/components/ui/modal";
import { apiRequest, errorMessage } from "@/lib/api-client";
import { maskConnectionString } from "@/lib/mask-url";

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
  return maskConnectionString(url);
}

export function StorageServerManager({ initialServers }: { initialServers: Server[] }) {
  const runAction = useApiAction();
  const { ref: modalRef, open: showModal, close: closeModalDialog } = useDialog();
  const { ref: deleteRef, open: showDeleteModal, close: closeDeleteDialog } = useDialog();
  const [servers, setServers] = useState(initialServers);
  const [editing, setEditing] = useState<Server | null>(null);
  const [deleting, setDeleting] = useState<Server | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
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
    showModal();
  }

  function openEdit(s: Server) {
    setEditing(s);
    setFormName(s.name);
    setFormUrl(s.url ?? "");
    setFormDefault(s.isDefault);
    setFormProvider((s.provider as "sqlserver" | "postgres") ?? "sqlserver");
    setError(null);
    showModal();
  }

  function closeModal() {
    closeModalDialog();
    setEditing(null);
    setError(null);
  }

  function openDelete(s: Server) {
    setDeleting(s);
    showDeleteModal();
  }

  function closeDelete() {
    closeDeleteDialog();
    setDeleting(null);
  }

  async function reload() {
    const { data } = await apiRequest<Server[]>("/api/v1/storage-servers");
    setServers(data ?? []);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const body = { name: formName.trim(), url: formUrl.trim(), isDefault: formDefault, provider: formProvider };
    startTransition(async () => {
      try {
        await apiRequest(
          editing ? `/api/v1/storage-servers/${editing.id}` : "/api/v1/storage-servers",
          { method: editing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
        );
        closeModal();
        await reload();
      } catch (err) {
        setError(errorMessage(err));
      }
    });
  }

  async function handleDelete() {
    if (!deleting) return;
    setDeleteBusy(true);
    const done = await runAction(`/api/v1/storage-servers/${deleting.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmName: deleting.name }),
    }, "Servidor removido.");
    setDeleteBusy(false);
    if (!done) return;
    closeDelete();
    await reload();
  }

  async function handleTest(s: Server) {
    setTesting(s.id);
    try {
      const { data } = await apiRequest<{ healthy: boolean; latencyMs: number; database: string }>(`/api/v1/storage-servers/${s.id}/test`, { method: "POST" });
      setTestResults((p) => ({ ...p, [s.id]: data }));
      await reload();
    } catch (err) {
      setTestResults((p) => ({ ...p, [s.id]: { error: errorMessage(err) } }));
    } finally {
      setTesting(null);
    }
  }

  async function handleSetDefault(s: Server) {
    const done = await runAction(`/api/v1/storage-servers/${s.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isDefault: true }),
    }, "Servidor padrão atualizado.");
    if (done) await reload();
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Infraestrutura"
        title="Servidores de armazenamento"
        description="Gerencie os SQL Servers onde os dados dos datasets são armazenados."
        actions={<button className="btn btn-sm btn-primary gap-2" onClick={openCreate}><Plus size={15} />Adicionar servidor</button>}
      />

      <Panel>
        <div className="px-5 py-4 text-sm text-base-content/65">
          {servers.length} servidor{servers.length !== 1 ? "es" : ""}
        </div>

        {servers.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-base-content/65">
            <Database size={36} />
            <p className="text-sm">Nenhum servidor cadastrado</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="table table-sm table-stack">
              <thead>
                <tr className="border-t border-base-300 text-xs uppercase tracking-wide text-base-content/65">
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
                      <td data-label="Nome">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{s.name}</span>
                          {s.isDefault && <span className="badge badge-xs badge-primary">padrão</span>}
                          {!s.active && <span className="badge badge-xs badge-ghost">inativo</span>}
                          <span className={`badge badge-xs ${s.provider === "postgres" ? "badge-info" : "badge-warning"}`}>
                            {s.provider === "postgres" ? "PG" : "MSSQL"}
                          </span>
                        </div>
                      </td>
                      <td data-label="URL" className="max-w-xs truncate font-mono text-xs text-base-content/65">{maskedUrl(s.url)}</td>
                      <td data-label="Datasets" className="text-center text-sm">{s._count.datasets}</td>
                      <td data-label="Status" className="text-center">
                        {tr && "error" in tr
                          ? <span className="badge badge-sm badge-error gap-1"><CircleX size={11} />{tr.error}</span>
                          : tr && "healthy" in tr
                          ? <span className="badge badge-sm badge-success gap-1"><CheckCircle2 size={11} />{tr.latencyMs}ms · {tr.database}</span>
                          : statusBadge(s)}
                      </td>
                      <td data-label="Ações">
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
                            <button className="btn btn-xs btn-ghost text-error" onClick={() => openDelete(s)} title="Remover">
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
      </Panel>

      <dialog ref={modalRef} className="modal">
        <div className="modal-box max-w-lg">
          <h3 className="text-lg font-bold">{editing ? "Editar servidor" : "Adicionar servidor"}</h3>
          <form onSubmit={(e) => { void handleSubmit(e); }} className="mt-5 space-y-4">
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
              {editing && <label className="label"><span className="label-text-alt text-base-content/65">Provider não pode ser alterado após criação.</span></label>}
            </div>

            <div className="form-control">
              <label className="label">
                <span className="label-text font-medium">URL de conexão</span>
                <span className="label-text-alt text-base-content/65">{formProvider === "postgres" ? "PostgreSQL" : "SQL Server"}</span>
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
                <span className="label-text-alt text-base-content/65">A URL é criptografada antes de ser salva.</span>
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

            {error && <div className="alert alert-error alert-sm text-sm">{error}</div>}

            <div className="modal-action">
              <button type="button" className="btn btn-sm btn-ghost" onClick={closeModal}>Cancelar</button>
              <button type="submit" className="btn btn-sm btn-primary" disabled={isPending}>
                {isPending ? <span className="loading loading-spinner loading-xs" /> : null}
                {editing ? "Salvar" : "Adicionar"}
              </button>
            </div>
          </form>
        </div>
        <ModalBackdrop onClose={closeModal} />
      </dialog>

      <dialog ref={deleteRef} className="modal">
        <div className="modal-box max-w-md">
          <h3 className="text-lg font-bold">Remover servidor de armazenamento</h3>
          <p className="mt-2 text-sm text-base-content/65">
            {deleting?._count.datasets
              ? `Este servidor tem ${deleting._count.datasets} dataset(s) associado(s) e não pode ser removido — migre-os para outro servidor primeiro.`
              : "Remove o registro do servidor e suas credenciais. Isso não pode ser desfeito."}
          </p>
          {deleting && !deleting._count.datasets && (
            <DangerZone
              description="Aplicações e datasets que ainda referenciarem este servidor deixarão de funcionar."
              confirmValue={deleting.name}
              confirmLabel="Remover definitivamente"
              busyLabel="Removendo..."
              busy={deleteBusy}
              onConfirm={handleDelete}
            />
          )}
          <div className="modal-action">
            <button type="button" className="btn btn-sm btn-ghost" onClick={closeDelete}>Cancelar</button>
          </div>
        </div>
        <ModalBackdrop onClose={closeDelete} />
      </dialog>
    </div>
  );
}
