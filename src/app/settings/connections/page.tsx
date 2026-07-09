"use client";
import { useEffect, useRef, useState } from "react";
import { CloudCog, DatabaseZap, Pencil, Plus, RefreshCw, Server, Trash2 } from "lucide-react";
import { PageHeader, Panel, StatusBadge } from "@/components/ui/primitives";

type Connection = { id: string; name: string; provider: string; environment: string; server: string; port: number | null; databaseName: string; sslMode: string; username: string; active: boolean; lastStatus: string | null; lastLatencyMs: number | null; lastCheckedAt: string | null };

export default function ConnectionsPage() {
  const [rows, setRows] = useState<Connection[]>([]);
  const [testing, setTesting] = useState("");
  const [editing, setEditing] = useState<Connection | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  async function load() { const r = await fetch("/api/v1/connections"), b = await r.json(); setRows(b.data ?? []); }
  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/connections").then(r => r.json()).then(b => { if (!cancelled) setRows(b.data ?? []); });
    return () => { cancelled = true; };
  }, []);
  function openCreate() { setEditing(null); dialog.current?.showModal(); }
  function openEdit(c: Connection) { setEditing(c); dialog.current?.showModal(); }
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const payload = Object.fromEntries(f);
    payload.provider = "postgres";
    if (editing && !payload.password) delete payload.password;
    await fetch(editing ? `/api/v1/connections/${editing.id}` : "/api/v1/connections", { method: editing ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    dialog.current?.close(); setEditing(null); await load();
  }
  async function test(id: string) { setTesting(id); await fetch(`/api/v1/connections/${id}/test`, { method: "POST" }); setTesting(""); await load(); }
  async function remove(c: Connection) { if (!confirm(`Remover a conexão "${c.name}"?`)) return; await fetch(`/api/v1/connections/${c.id}`, { method: "DELETE" }); await load(); }
  const active = rows.filter(c => c.active);
  return <div className="space-y-6"><PageHeader eyebrow="Configurações" title="Conexões Postgres" description="Fontes externas para live connection e data extract." actions={<button className="btn btn-primary btn-sm" onClick={openCreate}><Plus size={15} />Nova conexão</button>} /><div className="alert alert-info alert-soft"><CloudCog size={18} />Senhas ficam criptografadas e nunca retornam ao navegador.</div><div className="grid gap-5 xl:grid-cols-2">{active.map(c => <Panel key={c.id}><div className="p-5"><div className="flex items-start justify-between gap-3"><div className="flex gap-3"><span className="grid size-11 place-items-center rounded-xl bg-primary/10 text-primary"><DatabaseZap size={20} /></span><div><div className="flex items-center gap-2"><h2 className="font-semibold">{c.name}</h2><StatusBadge status={c.lastStatus === "healthy" ? "healthy" : c.lastStatus ? "warning" : "inactive"} /></div><p className="text-xs text-base-content/45">{c.environment} · Postgres</p></div></div><div className="flex gap-1"><button onClick={() => openEdit(c)} className="btn btn-ghost btn-sm btn-square" aria-label="Editar"><Pencil size={15} /></button><button onClick={() => remove(c)} className="btn btn-ghost btn-sm btn-square text-error" aria-label="Remover"><Trash2 size={15} /></button></div></div><dl className="mt-5 grid gap-4 rounded-xl bg-base-200 p-4 text-sm sm:grid-cols-2"><div><dt>Host</dt><dd className="font-mono text-xs">{c.server}:{c.port ?? 5432}</dd></div><div><dt>Banco</dt><dd>{c.databaseName}</dd></div><div><dt>Usuário</dt><dd>{c.username}</dd></div><div><dt>SSL</dt><dd>{c.sslMode}</dd></div><div><dt>Latência</dt><dd>{c.lastLatencyMs ? `${c.lastLatencyMs} ms` : "Não testada"}</dd></div></dl><div className="mt-4 text-right"><button disabled={testing === c.id} onClick={() => test(c.id)} className="btn btn-outline btn-sm"><RefreshCw size={14} className={testing === c.id ? "animate-spin" : ""} />Testar conexão</button></div></div></Panel>)}</div><dialog ref={dialog} className="modal"><form onSubmit={save} className="modal-box max-w-2xl"><h3 className="text-lg font-bold">{editing ? "Editar conexão" : "Nova conexão Postgres"}</h3><div className="mt-5 grid gap-4 sm:grid-cols-2"><input required name="name" defaultValue={editing?.name} placeholder="Nome" className="input w-full" /><select name="environment" defaultValue={editing?.environment ?? "Produção"} className="select w-full"><option>Produção</option><option>Homologação</option><option>Desenvolvimento</option></select><input required name="server" defaultValue={editing?.server} placeholder="postgres.exemplo.com" className="input w-full" /><input required name="port" defaultValue={editing?.port ?? 5432} placeholder="5432" className="input w-full" /><input required name="databaseName" defaultValue={editing?.databaseName} placeholder="Banco" className="input w-full" /><select name="sslMode" defaultValue={editing?.sslMode ?? "require"} className="select w-full"><option value="require">require</option><option value="disable">disable</option><option value="verify-full">verify-full</option></select><input required name="username" defaultValue={editing?.username} placeholder="Usuário" className="input w-full" /><input required={!editing} type="password" name="password" placeholder={editing ? "Nova senha (deixe em branco para manter)" : "Senha"} className="input w-full" /></div><div className="modal-action"><button type="button" onClick={() => { dialog.current?.close(); setEditing(null); }} className="btn btn-ghost btn-sm">Cancelar</button><button className="btn btn-primary btn-sm"><Server size={14} />Salvar</button></div></form><form method="dialog" className="modal-backdrop"><button onClick={() => setEditing(null)}>fechar</button></form></dialog></div>;
}
