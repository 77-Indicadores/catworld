"use client";
import { useEffect, useRef, useState } from "react";
import { CheckCircle2, CloudCog, DatabaseZap, Pencil, Plus, RefreshCw, Server, Trash2, XCircle } from "lucide-react";
import { EmptyState, PageHeader, Panel, StatusBadge } from "@/components/ui/primitives";

type Connection = { id: string; name: string; provider: string; environment: string; server: string; port: number | null; databaseName: string; sslMode: string; username: string; active: boolean; lastStatus: string | null; lastLatencyMs: number | null; lastCheckedAt: string | null };
type TestState = null | { ok: true; latencyMs: number; database?: string } | { ok: false; message: string };

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="form-control w-full"><span className="label-text font-medium">{label}</span><div className="mt-1">{children}</div>{hint && <span className="label-text-alt mt-1 text-base-content/55">{hint}</span>}</label>;
}

function providerLabel(provider: string) {
  return provider === "mssql" ? "SQL Server" : "PostgreSQL";
}

function mssqlSslLabel(sslMode: string) {
  if (sslMode === "encrypt-trust") return "Encrypt + Trust Certificate";
  if (sslMode === "no-encrypt") return "Sem criptografia";
  if (sslMode === "no-encrypt-trust") return "Sem criptografia + Trust";
  return "Encrypt";
}

export default function ConnectionsPage() {
  const [rows, setRows] = useState<Connection[]>([]);
  const [testing, setTesting] = useState("");
  const [editing, setEditing] = useState<Connection | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formTesting, setFormTesting] = useState(false);
  const [formTest, setFormTest] = useState<TestState>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [provider, setProvider] = useState<"postgres" | "mssql">("postgres");
  const dialog = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  async function load() {
    setLoading(true);
    const response = await fetch("/api/v1/connections");
    const body = await response.json();
    setRows(body.data ?? []);
    setLoading(false);
  }

  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/connections").then(r => r.json()).then(body => {
      if (!cancelled) setRows(body.data ?? []);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  function openCreate() { setEditing(null); setProvider("postgres"); setError(""); setNotice(""); setFormTest(null); dialog.current?.showModal(); }
  function openEdit(c: Connection) { setEditing(c); setProvider(c.provider === "mssql" ? "mssql" : "postgres"); setError(""); setNotice(""); setFormTest(null); dialog.current?.showModal(); }

  function formPayload(form: HTMLFormElement) {
    const f = new FormData(form);
    const payload: Record<string, unknown> = Object.fromEntries(f);
    payload.provider = provider;
    if (provider === "mssql") {
      payload.encrypt = f.get("encrypt") === "on";
      payload.trustServerCert = f.get("trustServerCert") === "on";
      delete payload.sslMode;
    }
    return payload;
  }

  async function testForm() {
    if (!formRef.current) return;
    const payload = formPayload(formRef.current);
    const missing = (["server", "databaseName", "username"] as const).filter(k => !String(payload[k] ?? "").trim());
    const needsPassword = !editing && !String(payload.password ?? "").trim();
    if (missing.length || needsPassword) {
      setFormTest({ ok: false, message: "Preencha servidor, banco e credenciais antes de testar." });
      return;
    }
    setFormTesting(true); setFormTest(null);
    // In edit mode without a new password, pass the existing encryptedCredentials
    if (editing && !payload.password) {
      payload.connectionId = editing.id;
      delete payload.password;
    }
    const response = await fetch("/api/v1/connections/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const body = await response.json().catch(() => ({}));
    setFormTesting(false);
    if (!response.ok) setFormTest({ ok: false, message: body.error?.message ?? "Falha ao conectar" });
    else setFormTest({ ok: true, latencyMs: body.data?.latencyMs ?? 0, database: body.data?.database });
  }

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(""); setSaving(true);
    const payload = formPayload(e.currentTarget);
    if (editing && !payload.password) delete payload.password;
    const response = await fetch(editing ? `/api/v1/connections/${editing.id}` : "/api/v1/connections", { method: editing ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    setSaving(false);
    if (!response.ok) { const body = await response.json(); setError(body.error?.message ?? "Falha ao salvar conexão"); return; }
    dialog.current?.close(); setEditing(null); setNotice("Conexão salva."); await load();
  }

  async function test(id: string) {
    setTesting(id); setNotice(""); setError("");
    const response = await fetch(`/api/v1/connections/${id}/test`, { method: "POST" });
    const body = await response.json().catch(() => ({}));
    setTesting("");
    if (!response.ok) setError(body.error?.message ?? "Falha ao testar conexão");
    else setNotice(`Conexão testada em ${body.data?.latencyMs ?? "?"} ms.`);
    await load();
  }

  async function remove(c: Connection) { if (!confirm(`Remover a conexão "${c.name}"?`)) return; await fetch(`/api/v1/connections/${c.id}`, { method: "DELETE" }); setNotice("Conexão removida."); await load(); }
  const active = rows.filter(c => c.active);
  const isMssqlEdit = editing?.provider === "mssql";

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Configurações" title="Conexões de banco de dados" description="Cadastre bancos de dados externos para consultar direto na origem ou copiar dados para datasets do Catworld." actions={<button className="btn btn-primary btn-sm" onClick={openCreate}><Plus size={15} />Nova conexão</button>} />
      {notice && <div className="alert alert-success alert-soft"><CheckCircle2 size={18} />{notice}</div>}
      {error && <div className="alert alert-error alert-soft">{error}</div>}
      <div className="alert alert-info alert-soft"><CloudCog size={18} />As credenciais ficam criptografadas e a senha nunca volta para o navegador.</div>
      {loading ? <div className="rounded-box border border-base-300 bg-base-100 p-10 text-center"><span className="loading loading-spinner" /></div> : active.length === 0 ? (
        <Panel><EmptyState icon={<DatabaseZap size={28} />} title="Nenhuma conexão cadastrada" description="Crie uma conexão para adicionar fontes live ou copiar tabelas para datasets." action={<button className="btn btn-primary btn-sm" onClick={openCreate}><Plus size={15} />Criar conexão</button>} /></Panel>
      ) : (
        <div className="grid gap-5 xl:grid-cols-2">
          {active.map(c => (
            <Panel key={c.id}>
              <div className="p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex gap-3">
                    <span className="grid size-11 place-items-center rounded-xl bg-primary/10 text-primary"><DatabaseZap size={20} /></span>
                    <div>
                      <div className="flex items-center gap-2">
                        <h2 className="font-semibold">{c.name}</h2>
                        <StatusBadge status={c.lastStatus === "healthy" ? "healthy" : c.lastStatus ? "warning" : "inactive"} />
                      </div>
                      <p className="text-xs text-base-content/45">{c.environment} · {providerLabel(c.provider)}</p>
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <button onClick={() => openEdit(c)} className="btn btn-ghost btn-sm btn-square" aria-label="Editar"><Pencil size={15} /></button>
                    <button onClick={() => remove(c)} className="btn btn-ghost btn-sm btn-square text-error" aria-label="Remover"><Trash2 size={15} /></button>
                  </div>
                </div>
                <dl className="mt-5 grid gap-4 rounded-xl bg-base-200 p-4 text-sm sm:grid-cols-2">
                  <div><dt>Host</dt><dd className="font-mono text-xs">{c.server}:{c.port ?? (c.provider === "mssql" ? 1433 : 5432)}</dd></div>
                  <div><dt>Banco</dt><dd>{c.databaseName}</dd></div>
                  <div><dt>Usuário</dt><dd>{c.username}</dd></div>
                  <div><dt>{c.provider === "mssql" ? "TLS" : "SSL"}</dt><dd>{c.provider === "mssql" ? mssqlSslLabel(c.sslMode) : c.sslMode}</dd></div>
                  <div><dt>Último teste</dt><dd>{c.lastLatencyMs ? `${c.lastLatencyMs} ms` : "Não testada"}</dd></div>
                </dl>
                <div className="mt-4 text-right">
                  <button disabled={testing === c.id} onClick={() => test(c.id)} className="btn btn-outline btn-sm">
                    <RefreshCw size={14} className={testing === c.id ? "animate-spin" : ""} />{testing === c.id ? "Testando..." : "Testar conexão"}
                  </button>
                </div>
              </div>
            </Panel>
          ))}
        </div>
      )}
      <dialog ref={dialog} className="modal">
        <form ref={formRef} onSubmit={save} className="modal-box max-w-2xl">
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-bold">{editing ? "Editar conexão" : "Nova conexão"}</h3>
            {editing && <span className="badge badge-ghost badge-sm">{providerLabel(editing.provider)}</span>}
          </div>
          <p className="mt-1 text-sm text-base-content/60">Use um usuário com permissão de leitura nas tabelas que serão consultadas.</p>
          <div className="mt-5 space-y-5">
            <section>
              <h4 className="text-sm font-semibold">Identificação</h4>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <Field label="Nome da conexão"><input required name="name" defaultValue={editing?.name} className="input w-full" /></Field>
                <Field label="Ambiente"><select name="environment" defaultValue={editing?.environment ?? "Produção"} className="select w-full"><option>Produção</option><option>Homologação</option><option>Desenvolvimento</option></select></Field>
              </div>
              {!editing && (
                <div className="mt-4">
                  <Field label="Tipo de banco">
                    <select className="select w-full" value={provider} onChange={e => { setProvider(e.target.value as "postgres" | "mssql"); setFormTest(null); }}>
                      <option value="postgres">PostgreSQL</option>
                      <option value="mssql">SQL Server (MSSQL)</option>
                    </select>
                  </Field>
                </div>
              )}
            </section>
            <section>
              <h4 className="text-sm font-semibold">Servidor</h4>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <Field label={provider === "mssql" ? "Servidor" : "Host"} hint={provider === "mssql" ? "Endereço do SQL Server (ex: servidor\\instancia)." : "Endereço do servidor Postgres."}>
                  <input required name="server" defaultValue={editing?.server} className="input w-full" onChange={() => setFormTest(null)} />
                </Field>
                <Field label="Porta">
                  <input required name="port" defaultValue={editing?.port ?? (provider === "mssql" ? 1433 : 5432)} className="input w-full" inputMode="numeric" onChange={() => setFormTest(null)} />
                </Field>
                <Field label="Banco de dados">
                  <input required name="databaseName" defaultValue={editing?.databaseName} className="input w-full" onChange={() => setFormTest(null)} />
                </Field>
                {(provider === "mssql" || isMssqlEdit) ? (
                  <div className="flex flex-col gap-3 pt-1">
                    <label className="flex cursor-pointer items-center gap-2">
                      <input type="checkbox" name="encrypt" className="checkbox checkbox-sm" defaultChecked={!editing || editing.sslMode.startsWith("encrypt")} onChange={() => setFormTest(null)} />
                      <span className="text-sm">Criptografar conexão (Encrypt)</span>
                    </label>
                    <label className="flex cursor-pointer items-center gap-2">
                      <input type="checkbox" name="trustServerCert" className="checkbox checkbox-sm" defaultChecked={!!editing && editing.sslMode.includes("trust")} onChange={() => setFormTest(null)} />
                      <span className="text-sm">Confiar no certificado do servidor</span>
                    </label>
                  </div>
                ) : (
                  <Field label="Modo SSL" hint="Use require para bancos hospedados em nuvem.">
                    <select name="sslMode" defaultValue={editing?.sslMode ?? "require"} className="select w-full" onChange={() => setFormTest(null)}>
                      <option value="require">require</option>
                      <option value="disable">disable</option>
                      <option value="verify-full">verify-full</option>
                    </select>
                  </Field>
                )}
              </div>
            </section>
            <section>
              <h4 className="text-sm font-semibold">Credenciais</h4>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <Field label="Usuário"><input required name="username" defaultValue={editing?.username} className="input w-full" onChange={() => setFormTest(null)} /></Field>
                <Field label={editing ? "Nova senha" : "Senha"} hint={editing ? "Deixe em branco para manter a senha atual." : undefined}>
                  <input required={!editing} type="password" name="password" className="input w-full" onChange={() => setFormTest(null)} />
                </Field>
              </div>
            </section>

            {/* Test result inline */}
            <section>
              <div className="flex items-center gap-3">
                <button type="button" disabled={formTesting} onClick={testForm} className="btn btn-outline btn-sm">
                  <RefreshCw size={14} className={formTesting ? "animate-spin" : ""} />
                  {formTesting ? "Testando..." : "Testar conexão"}
                </button>
                {formTest?.ok === true && (
                  <span className="flex items-center gap-1.5 text-sm text-success">
                    <CheckCircle2 size={15} />
                    Conectado em {formTest.latencyMs} ms{formTest.database ? ` · ${formTest.database}` : ""}
                  </span>
                )}
                {formTest?.ok === false && (
                  <span className="flex items-center gap-1.5 text-sm text-error">
                    <XCircle size={15} />
                    {formTest.message}
                  </span>
                )}
              </div>
              {!formTest && !formTesting && (
                <p className="mt-1.5 text-xs text-base-content/45">Teste a conexão antes de salvar.</p>
              )}
            </section>
          </div>
          {error && <div className="alert alert-error alert-soft mt-4">{error}</div>}
          <div className="modal-action">
            <button type="button" onClick={() => { dialog.current?.close(); setEditing(null); setFormTest(null); }} className="btn btn-ghost btn-sm">Cancelar</button>
            <button disabled={saving} className="btn btn-primary btn-sm">
              <Server size={14} />{saving ? "Salvando..." : "Salvar"}
            </button>
          </div>
        </form>
        <form method="dialog" className="modal-backdrop"><button onClick={() => { setEditing(null); setFormTest(null); }}>fechar</button></form>
      </dialog>
    </div>
  );
}
