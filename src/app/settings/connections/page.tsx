"use client";
import { useEffect, useRef, useState } from "react";
import { CheckCircle2, CloudCog, DatabaseZap, Pencil, Plus, RefreshCw, Server, Trash2, XCircle } from "lucide-react";
import { EmptyState, PageHeader, Panel, StatusBadge } from "@/components/ui/primitives";
import { useApiAction, useFeedback } from "@/components/ui/feedback";
import { apiRequest, errorMessage } from "@/lib/api-client";
import { Time } from "@/components/ui/time";

type Connection = { id: string; name: string; provider: string; environment: string; server: string; port: number | null; databaseName: string; sslMode: string; username: string; active: boolean; lastStatus: string | null; lastLatencyMs: number | null; lastError: string | null; lastCheckedAt: string | null; sshTunnelEnabled?: boolean; sshHost?: string | null; sshPort?: number | null; sshUsername?: string | null; sshAuthMethod?: string | null; metadataJson?: string | null };
type TestState = null | { ok: true; latencyMs: number; database?: string } | { ok: false; message: string };
type Provider = "postgres" | "mssql" | "firebird-ftp";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="form-control w-full"><span className="label-text font-medium">{label}</span><div className="mt-1">{children}</div>{hint && <span className="label-text-alt mt-1 text-base-content/65">{hint}</span>}</label>;
}

function providerLabel(provider: string) {
  if (provider === "mssql") return "SQL Server";
  if (provider === "firebird-ftp") return "Firebird (via FTP)";
  return "PostgreSQL";
}

const DEFAULT_PORT: Record<Provider, number> = { postgres: 5432, mssql: 1433, "firebird-ftp": 21 };

/** Ausente = DEFAULT_FIREBIRD_POLL_MINUTES em firebird-materialize.ts — mantido em sincronia manualmente (é só o valor mostrado no placeholder/default do formulário). */
const DEFAULT_FIREBIRD_POLL_MINUTES = 60;

/** `Connection.metadataJson` de uma conexao firebird-ftp: só o caminho/padrão do FTP e do backup (sem segredo) — ver parseFirebirdFtpConfig em sources.ts. */
function firebirdMeta(c: Connection | null): { remotePath: string; filePattern: string; innerFilePattern: string; charset: string; pollMinutes: number } {
  const empty = { remotePath: "", filePattern: "", innerFilePattern: "", charset: "", pollMinutes: DEFAULT_FIREBIRD_POLL_MINUTES };
  if (!c?.metadataJson) return empty;
  try {
    const parsed = JSON.parse(c.metadataJson) as { ftp?: { remotePath?: string; filePattern?: string; pollMinutes?: number }; firebird?: { innerFilePattern?: string; charset?: string } };
    return {
      remotePath: parsed.ftp?.remotePath ?? "",
      filePattern: parsed.ftp?.filePattern ?? "",
      innerFilePattern: parsed.firebird?.innerFilePattern ?? "",
      charset: parsed.firebird?.charset ?? "",
      pollMinutes: parsed.ftp?.pollMinutes ?? DEFAULT_FIREBIRD_POLL_MINUTES,
    };
  } catch {
    return empty;
  }
}

function mssqlSslLabel(sslMode: string) {
  if (sslMode === "encrypt-trust") return "Encrypt + Trust Certificate";
  if (sslMode === "no-encrypt") return "Sem criptografia";
  if (sslMode === "no-encrypt-trust") return "Sem criptografia + Trust";
  return "Encrypt";
}

export default function ConnectionsPage() {
  const { confirm: askConfirm } = useFeedback(); const runAction = useApiAction();
  const [rows, setRows] = useState<Connection[]>([]);
  const [testing, setTesting] = useState("");
  const [editing, setEditing] = useState<Connection | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formTesting, setFormTesting] = useState(false);
  const [formTest, setFormTest] = useState<TestState>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [provider, setProvider] = useState<Provider>("postgres");
  const [sshEnabled, setSshEnabled] = useState(false);
  const [sshAuthMethod, setSshAuthMethod] = useState<"password" | "privateKey">("password");
  const dialog = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  async function load() {
    setLoading(true);
    try {
      const { data } = await apiRequest<Connection[]>("/api/v1/connections");
      setRows(data ?? []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    apiRequest<Connection[]>("/api/v1/connections").then(({ data }) => {
      if (!cancelled) setRows(data ?? []);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  function openCreate() { setEditing(null); setProvider("postgres"); setSshEnabled(false); setSshAuthMethod("password"); setError(""); setNotice(""); setFormTest(null); dialog.current?.showModal(); }
  function openEdit(c: Connection) { setEditing(c); setProvider(c.provider === "mssql" ? "mssql" : c.provider === "firebird-ftp" ? "firebird-ftp" : "postgres"); setSshEnabled(!!c.sshTunnelEnabled); setSshAuthMethod(c.sshAuthMethod === "privateKey" ? "privateKey" : "password"); setError(""); setNotice(""); setFormTest(null); dialog.current?.showModal(); }

  function formPayload(form: HTMLFormElement) {
    const f = new FormData(form);
    const payload: Record<string, unknown> = Object.fromEntries(f);
    payload.provider = provider;
    if (provider === "mssql") {
      payload.encrypt = f.get("encrypt") === "on";
      payload.trustServerCert = f.get("trustServerCert") === "on";
      delete payload.sslMode;
    }
    if (provider === "firebird-ftp") {
      // Sem tunel SSH nem databaseName/SSL de verdade para este provider (ver POST /api/v1/connections).
      delete payload.sslMode; delete payload.databaseName;
      payload.sshTunnelEnabled = false;
      // innerFilePattern/charset sao opcionais (z.string().min(1).optional()): um <input> vazio manda "" via
      // FormData, e "" reprova o min(1) mesmo sendo optional (optional só pula quando o valor é undefined) —
      // sem isto, salvar com esses campos em branco (o caso comum) falharia na validacao.
      if (!String(payload.innerFilePattern ?? "").trim()) delete payload.innerFilePattern;
      if (!String(payload.charset ?? "").trim()) delete payload.charset;
      // Mesmo motivo: pollMinutes vazio viraria 0 no z.coerce.number() (falha o min(1)) em vez de "usar o padrão".
      if (!String(payload.pollMinutes ?? "").trim()) delete payload.pollMinutes;
    } else {
      payload.sshTunnelEnabled = f.get("sshTunnelEnabled") === "on";
    }
    if (!payload.sshTunnelEnabled) {
      delete payload.sshHost; delete payload.sshPort; delete payload.sshUsername; delete payload.sshAuthMethod;
      delete payload.sshPassword; delete payload.sshPrivateKey; delete payload.sshPassphrase;
    }
    return payload;
  }

  async function testForm() {
    if (!formRef.current) return;
    const payload = formPayload(formRef.current);
    const requiredFields = provider === "firebird-ftp" ? (["server", "username", "remotePath", "filePattern"] as const) : (["server", "databaseName", "username"] as const);
    const missing = requiredFields.filter(k => !String(payload[k] ?? "").trim());
    const needsPassword = !editing && !String(payload.password ?? "").trim();
    if (missing.length || needsPassword) {
      const what = provider === "firebird-ftp" ? "servidor FTP, caminho remoto/padrão do arquivo e credenciais" : "servidor, banco e credenciais";
      setFormTest({ ok: false, message: `Preencha ${what} antes de testar.` });
      return;
    }
    setFormTesting(true); setFormTest(null);
    // In edit mode without a new password, pass the existing encryptedCredentials
    if (editing && !payload.password) {
      payload.connectionId = editing.id;
      delete payload.password;
    }
    try {
      const { data } = await apiRequest<{ latencyMs?: number; database?: string }>("/api/v1/connections/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      setFormTest({ ok: true, latencyMs: data?.latencyMs ?? 0, database: data?.database });
    } catch (err) {
      setFormTest({ ok: false, message: errorMessage(err) });
    } finally {
      setFormTesting(false);
    }
  }

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(""); setSaving(true);
    const payload = formPayload(e.currentTarget);
    if (editing && !payload.password) delete payload.password;
    try {
      await apiRequest(editing ? `/api/v1/connections/${editing.id}` : "/api/v1/connections", { method: editing ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    } catch (err) {
      setSaving(false);
      setError(errorMessage(err));
      return;
    }
    setSaving(false);
    dialog.current?.close(); setEditing(null); setNotice("Conexão salva."); await load();
  }

  async function test(id: string) {
    setTesting(id); setNotice(""); setError("");
    try {
      const { data } = await apiRequest<{ latencyMs?: number }>(`/api/v1/connections/${id}/test`, { method: "POST" });
      setNotice(`Conexão testada em ${data?.latencyMs ?? "?"} ms.`);
    } catch (err) {
      setError(errorMessage(err));
    }
    setTesting("");
    await load();
  }

  async function remove(c: Connection) {
    if (!await askConfirm({ title: "Remover conexão", message: `Remover a conexão "${c.name}"?`, confirmLabel: "Remover", danger: true })) return;
    if (await runAction(`/api/v1/connections/${c.id}`, { method: "DELETE" })) setNotice("Conexão removida.");
    await load();
  }
  const active = rows.filter(c => c.active);
  const isMssqlEdit = editing?.provider === "mssql";
  const isFirebirdFtp = provider === "firebird-ftp" || editing?.provider === "firebird-ftp";
  const firebirdDefaults = firebirdMeta(editing);

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
                        <StatusBadge status={c.lastStatus === "healthy" ? "healthy" : c.lastStatus === "error" ? "error" : "inactive"} label={c.lastStatus === "healthy" ? "Saudável" : c.lastStatus === "error" ? "Falhou" : "Não testada"} />
                      </div>
                      <p className="text-xs text-base-content/65">{c.environment} · {providerLabel(c.provider)}{c.sshTunnelEnabled ? " · Túnel SSH" : ""}</p>
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <button onClick={() => openEdit(c)} className="btn btn-ghost btn-sm btn-square" aria-label="Editar"><Pencil size={15} /></button>
                    <button onClick={() => remove(c)} className="btn btn-ghost btn-sm btn-square text-error" aria-label="Remover"><Trash2 size={15} /></button>
                  </div>
                </div>
                <dl className="mt-5 grid gap-4 rounded-xl bg-base-200 p-4 text-sm sm:grid-cols-2">
                  <div><dt>{c.provider === "firebird-ftp" ? "Host do FTP" : "Host"}</dt><dd className="font-mono text-xs">{c.server}:{c.port ?? DEFAULT_PORT[c.provider === "mssql" ? "mssql" : c.provider === "firebird-ftp" ? "firebird-ftp" : "postgres"]}</dd></div>
                  <div><dt>{c.provider === "firebird-ftp" ? "Caminho remoto" : "Banco"}</dt><dd className={c.provider === "firebird-ftp" ? "font-mono text-xs" : ""}>{c.databaseName}</dd></div>
                  <div><dt>{c.provider === "firebird-ftp" ? "Usuário FTP" : "Usuário"}</dt><dd>{c.username}</dd></div>
                  {c.provider === "firebird-ftp" ? (
                    <>
                      <div><dt>Padrão do arquivo</dt><dd className="font-mono text-xs">{firebirdMeta(c).filePattern || "—"}</dd></div>
                      <div><dt>Verifica a cada</dt><dd>{firebirdMeta(c).pollMinutes} min</dd></div>
                    </>
                  ) : (
                    <div><dt>{c.provider === "mssql" ? "TLS" : "SSL"}</dt><dd>{c.provider === "mssql" ? mssqlSslLabel(c.sslMode) : c.sslMode}</dd></div>
                  )}
                  <div>
                    <dt>Último teste</dt>
                    <dd>
                      {c.lastCheckedAt
                        ? <>{c.lastStatus === "healthy" ? `${c.lastLatencyMs} ms` : "Falhou"} · <Time iso={c.lastCheckedAt} relative /></>
                        : "Não testada"}
                    </dd>
                  </div>
                </dl>
                {c.lastStatus === "error" && c.lastError && (
                  <p className="mt-2 rounded bg-error/8 px-2 py-1 font-mono text-[11px] text-error">{c.lastError}</p>
                )}
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
          <p className="mt-1 text-sm text-base-content/65">Use um usuário com permissão de leitura nas tabelas que serão consultadas.</p>
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
                    <select className="select w-full" value={provider} onChange={e => { setProvider(e.target.value as Provider); setFormTest(null); }}>
                      <option value="postgres">PostgreSQL</option>
                      <option value="mssql">SQL Server (MSSQL)</option>
                      <option value="firebird-ftp">Firebird via FTP (backup .fdb)</option>
                    </select>
                  </Field>
                </div>
              )}
            </section>
            <section>
              <h4 className="text-sm font-semibold">{isFirebirdFtp ? "Servidor FTP" : "Servidor"}</h4>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <Field label={isFirebirdFtp ? "Host do FTP" : provider === "mssql" ? "Servidor" : "Host"} hint={isFirebirdFtp ? "Endereço do servidor FTP que recebe o backup." : provider === "mssql" ? "Endereço do SQL Server (ex: servidor\\instancia)." : "Endereço do servidor Postgres."}>
                  <input required name="server" defaultValue={editing?.server} className="input w-full" onChange={() => setFormTest(null)} />
                </Field>
                <Field label="Porta">
                  <input required name="port" defaultValue={editing?.port ?? DEFAULT_PORT[provider]} className="input w-full" inputMode="numeric" onChange={() => setFormTest(null)} />
                </Field>
                {isFirebirdFtp ? (
                  <>
                    <Field label="Caminho remoto" hint="Pasta no FTP onde o backup é depositado (ex: /backup).">
                      <input required name="remotePath" defaultValue={firebirdDefaults.remotePath} className="input w-full font-mono text-sm" onChange={() => setFormTest(null)} />
                    </Field>
                    <Field label="Padrão do arquivo" hint="Glob do arquivo mais recente (ex: *.zip).">
                      <input required name="filePattern" defaultValue={firebirdDefaults.filePattern} className="input w-full font-mono text-sm" onChange={() => setFormTest(null)} />
                    </Field>
                    <Field label="Padrão do arquivo dentro do ZIP (opcional)" hint="Deixe em branco para usar o único arquivo do ZIP.">
                      <input name="innerFilePattern" defaultValue={firebirdDefaults.innerFilePattern} className="input w-full font-mono text-sm" onChange={() => setFormTest(null)} />
                    </Field>
                    <Field label="Charset do backup (opcional)" hint="Ex: WIN1252 para ERPs Firebird antigos. Padrão: UTF8.">
                      <input name="charset" defaultValue={firebirdDefaults.charset} className="input w-full font-mono text-sm" onChange={() => setFormTest(null)} />
                    </Field>
                    <Field label="Verificar arquivo novo a cada (minutos)" hint="Sem cron por tabela: ao detectar um arquivo novo no FTP, todas as fontes desta conexão são atualizadas sozinhas. Ajuste pela frequência real de chegada do backup (ex: cliente manda 1x/dia → 60 min já é de sobra).">
                      <input name="pollMinutes" type="number" min={1} max={10080} defaultValue={firebirdDefaults.pollMinutes} className="input w-full" onChange={() => setFormTest(null)} />
                    </Field>
                  </>
                ) : (
                  <>
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
                  </>
                )}
              </div>
            </section>
            <section>
              <h4 className="text-sm font-semibold">Credenciais</h4>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <Field label={isFirebirdFtp ? "Usuário FTP" : "Usuário"}><input required name="username" defaultValue={editing?.username} className="input w-full" onChange={() => setFormTest(null)} /></Field>
                <Field label={editing ? (isFirebirdFtp ? "Nova senha FTP" : "Nova senha") : (isFirebirdFtp ? "Senha FTP" : "Senha")} hint={editing ? "Deixe em branco para manter a senha atual." : undefined}>
                  <input required={!editing} type="password" name="password" className="input w-full" onChange={() => setFormTest(null)} />
                </Field>
              </div>
            </section>

            {!isFirebirdFtp && (
            <section>
              <label className="flex cursor-pointer items-center gap-2">
                <input type="checkbox" name="sshTunnelEnabled" className="checkbox checkbox-sm" checked={sshEnabled} onChange={(e) => { setSshEnabled(e.target.checked); setFormTest(null); }} />
                <span className="text-sm font-semibold">Túnel SSH (opcional)</span>
              </label>
              {sshEnabled && (
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  <Field label="Host SSH" hint="Servidor de salto usado para acessar o banco.">
                    <input required name="sshHost" defaultValue={editing?.sshHost ?? ""} className="input w-full" onChange={() => setFormTest(null)} />
                  </Field>
                  <Field label="Porta SSH">
                    <input required name="sshPort" defaultValue={editing?.sshPort ?? 22} className="input w-full" inputMode="numeric" onChange={() => setFormTest(null)} />
                  </Field>
                  <Field label="Usuário SSH">
                    <input required name="sshUsername" defaultValue={editing?.sshUsername ?? ""} className="input w-full" onChange={() => setFormTest(null)} />
                  </Field>
                  <Field label="Autenticação">
                    <select name="sshAuthMethod" value={sshAuthMethod} onChange={(e) => { setSshAuthMethod(e.target.value as "password" | "privateKey"); setFormTest(null); }} className="select w-full">
                      <option value="password">Senha</option>
                      <option value="privateKey">Chave privada</option>
                    </select>
                  </Field>
                  {sshAuthMethod === "password" ? (
                    <Field label="Senha SSH" hint={editing?.sshTunnelEnabled ? "Deixe em branco para manter a senha atual." : undefined}>
                      <input type="password" name="sshPassword" className="input w-full" onChange={() => setFormTest(null)} />
                    </Field>
                  ) : (
                    <>
                      <Field label="Chave privada" hint={editing?.sshTunnelEnabled ? "Deixe em branco para manter a chave atual." : "Cole a chave privada (PEM)."}>
                        <textarea name="sshPrivateKey" className="textarea h-24 w-full font-mono text-xs" onChange={() => setFormTest(null)} />
                      </Field>
                      <Field label="Passphrase (opcional)">
                        <input type="password" name="sshPassphrase" className="input w-full" onChange={() => setFormTest(null)} />
                      </Field>
                    </>
                  )}
                </div>
              )}
            </section>
            )}

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
                <p className="mt-1.5 text-xs text-base-content/65">Teste a conexão antes de salvar.</p>
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
