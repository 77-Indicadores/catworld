"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { CircleAlert, CircleCheck, PlayCircle, RotateCw, SquarePen, StopCircle } from "lucide-react";
import { Panel, StatusBadge } from "@/components/ui/primitives";
import { useApiAction, useFeedback } from "@/components/ui/feedback";
import { apiRequest, errorMessage, warningsOf } from "@/lib/api-client";
import { COMMAND_ACTION_LABEL, COMMAND_STATUS_LABEL, JOB_TYPE_LABEL, WORKER_STATE_LABEL } from "@/lib/labels";
import type { Status } from "@/lib/types";
import { Time } from "@/components/ui/time";

type Runtime = { state: string; pid: number | null; restarts: number; lastExitCode: number | null; restartPending: boolean } | null;
type Profile = {
  id: string; name: string; jobTypes: string[]; concurrency: number; pollMs: number; duckdbMemoryLimit: string; enabled: boolean;
  runtime: Runtime; runningJobs?: number; queuedJobs?: number;
};
type Command = { id: string; action: string; mode: string; status: string; requestedBy: string; requestedAt: string; resultJson: string | null };
type Data = {
  supervisor: { supervised: boolean; hostname: string | null; pid: number | null; heartbeatAt: string | null };
  profiles: Profile[];
  commands: Command[];
};

const OPEN = new Set(["PENDING", "ACCEPTED", "DRAINING", "APPLYING"]);
const JOB_TYPES = Object.keys(JOB_TYPE_LABEL);

function stateBadge(p: Profile): { status: Status; label: string } {
  if (!p.enabled) return { status: "inactive", label: "Desabilitado" };
  const s = p.runtime?.state;
  if (!s) return { status: "warning", label: "Sem supervisor" };
  const label = WORKER_STATE_LABEL[s] ?? s;
  if (s === "RUNNING") return { status: "healthy", label };
  if (s === "CRASH_LOOP") return { status: "error", label };
  return { status: "warning", label };
}

const ago = (iso: string | null) => {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `há ${s}s` : s < 3600 ? `há ${Math.round(s / 60)} min` : `há ${Math.round(s / 3600)} h`;
};

export function WorkersSection() {
  const { confirm, notify } = useFeedback();
  const runAction = useApiAction();
  const [data, setData] = useState<Data | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Profile | "new" | null>(null);
  const [restarting, setRestarting] = useState<Profile | "all" | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await apiRequest<Data>("/api/v1/workers");
      setData(r.data);
      setWarnings(warningsOf(r.meta));
      setError("");
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  const hasOpenCommand = !!data?.commands.some((c) => OPEN.has(c.status));
  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    // Mais rápido enquanto um comando está em andamento; parado quando a aba está escondida.
    const id = window.setInterval(() => { if (!document.hidden) void load(); }, hasOpenCommand ? 2000 : 5000);
    return () => { window.clearTimeout(first); window.clearInterval(id); };
  }, [load, hasOpenCommand]);

  const supervised = data?.supervisor.supervised ?? false;

  async function send(body: Record<string, unknown>, success: string) {
    if (await runAction("/api/v1/system/commands", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, success)) await load();
  }

  async function restart(p: Profile | null, mode: "SAFE" | "IMMEDIATE") {
    await send(p ? { action: "RESTART_PROFILE", mode, profileId: p.id } : { action: "RESTART_ALL", mode }, "Reinício solicitado.");
  }

  async function toggle(p: Profile) {
    const stopping = p.enabled;
    const ok = await confirm({
      title: stopping ? "Parar worker" : "Iniciar worker",
      message: stopping ? `O worker "${p.name}" termina os jobs em andamento e para. Os jobs dos tipos dele ficam na fila até ele voltar.` : `O worker "${p.name}" volta a processar jobs.`,
      confirmLabel: stopping ? "Parar" : "Iniciar",
      danger: stopping,
    });
    if (!ok) return;
    await send({ action: stopping ? "STOP_PROFILE" : "START_PROFILE", mode: "SAFE", profileId: p.id }, stopping ? "Parada solicitada." : "Início solicitado.");
  }

  if (!data) {
    return (
      <Panel title="Workers">
        <div className="p-6 text-center">{error ? <div role="alert" className="alert alert-error alert-soft">{error}</div> : <span className="loading loading-spinner" />}</div>
      </Panel>
    );
  }

  return (
    <>
      <Panel
        title="Workers"
        action={
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-sm" disabled={!supervised} onClick={() => setRestarting("all")} aria-label="Reiniciar todos os workers"><RotateCw size={14} />Reiniciar todos</button>
            <button className="btn btn-primary btn-sm" onClick={() => setEditing("new")}>Novo worker</button>
          </div>
        }
      >
        <div className="space-y-3 p-5">
          {supervised ? (
            <p className="flex items-center gap-2 text-sm text-base-content/70">
              <CircleCheck size={16} className="text-success" />
              Supervisor ativo em {data.supervisor.hostname} (pid {data.supervisor.pid}), pulsação {ago(data.supervisor.heartbeatAt)}.
            </p>
          ) : (
            <div role="alert" className="alert alert-warning alert-soft text-sm">
              <CircleAlert size={16} />
              <span>
                Nenhum supervisor está ativo, então os workers não estão sendo gerenciados e o reinício pela tela fica desabilitado.
                Suba o serviço <code className="font-mono">workers</code> (ou rode <code className="font-mono">npm run supervisor</code>). Você ainda pode editar os perfis.
              </span>
            </div>
          )}
          {warnings.map((w) => <div key={w} role="status" className="alert alert-warning alert-soft text-sm">{w}</div>)}
          {error && <div role="alert" className="alert alert-error alert-soft text-sm">{error}</div>}
        </div>

        <div className="overflow-x-auto">
          <table className="table table-sm table-stack">
            <caption className="sr-only">Workers configurados</caption>
            <thead>
              <tr>
                <th scope="col">Worker</th><th scope="col">Processa</th><th scope="col">Paralelo</th>
                <th scope="col">Estado</th><th scope="col">Jobs (rodando / na fila)</th><th scope="col"><span className="sr-only">Ações</span></th>
              </tr>
            </thead>
            <tbody>
              {data.profiles.map((p) => {
                const badge = stateBadge(p);
                return (
                  <tr key={p.id}>
                    <td data-label="Worker">
                      <div className="font-mono text-sm">{p.name}</div>
                      {p.runtime?.pid && <div className="text-[11px] text-base-content/65">pid {p.runtime.pid}{p.runtime.restarts ? ` · ${p.runtime.restarts} reinício(s)` : ""}</div>}
                    </td>
                    <td data-label="Processa" className="max-w-64 text-xs">{p.jobTypes.map((t) => JOB_TYPE_LABEL[t]?.label ?? t).join(", ")}</td>
                    <td data-label="Paralelo" className="text-sm">{p.concurrency}</td>
                    <td data-label="Estado">
                      <StatusBadge status={badge.status} label={badge.label} />
                      {p.runtime?.restartPending && <div className="mt-1 text-[11px] text-warning">Reinício pendente: a mudança de tipos/paralelismo só vale depois de reiniciar</div>}
                    </td>
                    <td data-label="Jobs (rodando / na fila)" className="text-sm">{p.runningJobs ?? 0} / {p.queuedJobs ?? 0}</td>
                    <td data-label="">
                      <div className="flex flex-wrap justify-end gap-1">
                        <button className="btn btn-ghost btn-xs" onClick={() => setEditing(p)} aria-label={`Editar ${p.name}`}><SquarePen size={13} />Editar</button>
                        <button className="btn btn-ghost btn-xs" disabled={!supervised || !p.enabled} onClick={() => setRestarting(p)} aria-label={`Reiniciar ${p.name}`}><RotateCw size={13} />Reiniciar</button>
                        <button className="btn btn-ghost btn-xs" disabled={!supervised} onClick={() => toggle(p)} aria-label={`${p.enabled ? "Parar" : "Iniciar"} ${p.name}`}>
                          {p.enabled ? <><StopCircle size={13} />Parar</> : <><PlayCircle size={13} />Iniciar</>}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {data.commands.length > 0 && (
          <div className="border-t border-base-300 p-5">
            <h3 className="mb-2 text-sm font-semibold">Últimos comandos</h3>
            <ul className="space-y-1 text-xs">
              {data.commands.slice(0, 5).map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-medium">{COMMAND_ACTION_LABEL[c.action] ?? c.action}{c.mode === "IMMEDIATE" ? " (agora)" : ""}</span>
                  <span className={OPEN.has(c.status) ? "text-warning" : c.status === "FAILED" ? "text-error" : "text-base-content/70"}>{COMMAND_STATUS_LABEL[c.status] ?? c.status}</span>
                  <span className="text-base-content/65">{c.requestedBy} · <Time iso={c.requestedAt} /></span>
                  {c.status === "FAILED" && c.resultJson && <span className="text-error">{safeError(c.resultJson)}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Panel>

      {restarting && (
        <RestartDialog
          target={restarting === "all" ? null : restarting}
          onClose={() => setRestarting(null)}
          onConfirm={async (mode) => {
            const t = restarting;
            setRestarting(null);
            await restart(t === "all" ? null : t, mode);
          }}
        />
      )}

      {editing && (
        <ProfileDialog
          profile={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async (restartRequired) => {
            setEditing(null);
            notify("success", restartRequired ? "Salvo. Reinicie o worker para aplicar a mudança de tipos/paralelismo." : "Salvo.");
            await load();
          }}
        />
      )}
    </>
  );
}

function safeError(json: string): string {
  try {
    return String((JSON.parse(json) as { error?: string }).error ?? "");
  } catch {
    return "";
  }
}

function ProfileDialog({ profile, onClose, onSaved }: { profile: Profile | null; onClose: () => void; onSaved: (restartRequired: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [name, setName] = useState(profile?.name ?? "");
  const [types, setTypes] = useState<string[]>(profile?.jobTypes ?? []);
  const [concurrency, setConcurrency] = useState(profile?.concurrency ?? 1);
  const [pollMs, setPollMs] = useState(profile?.pollMs ?? 2000);
  const [memory, setMemory] = useState(profile?.duckdbMemoryLimit ?? "1GB");
  const [enabled, setEnabled] = useState(profile?.enabled ?? true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => { ref.current?.showModal(); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (types.length === 0) { setError("Escolha ao menos um tipo de job."); return; }
    setSaving(true);
    try {
      const body = { jobTypes: types, concurrency, pollMs, duckdbMemoryLimit: memory, enabled };
      const r = profile
        ? await apiRequest(`/api/v1/worker-profiles/${profile.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
        : await apiRequest("/api/v1/worker-profiles", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, ...body }) });
      onSaved(r.meta?.restartRequired === true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const toggleType = (t: string) => setTypes((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));

  return (
    <dialog ref={ref} className="modal" aria-labelledby={titleId} onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <form onSubmit={submit} className="modal-box max-w-xl">
        <h3 id={titleId} className="text-lg font-bold">{profile ? `Editar ${profile.name}` : "Novo worker"}</h3>
        <div className="mt-4 space-y-4">
          <label className="fieldset">
            <span className="fieldset-legend">Nome</span>
            <input className="input w-full font-mono" value={name} onChange={(e) => setName(e.target.value)} disabled={!!profile} required pattern="[a-z0-9][a-z0-9\-]{0,62}" placeholder="worker-relatorios" />
            <span className="label text-xs">Letras minúsculas, números e hífen. Não muda depois de criado.</span>
          </label>
          <fieldset className="fieldset">
            <legend className="fieldset-legend">Tipos de job que este worker processa</legend>
            <div className="space-y-1">
              {JOB_TYPES.map((t) => (
                <label key={t} className="flex cursor-pointer items-start gap-2 text-sm">
                  <input type="checkbox" className="checkbox checkbox-sm mt-0.5" checked={types.includes(t)} onChange={() => toggleType(t)} />
                  <span><span className="font-medium">{JOB_TYPE_LABEL[t]!.label}</span><span className="block text-xs text-base-content/70">{JOB_TYPE_LABEL[t]!.hint}</span></span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="fieldset">
              <span className="fieldset-legend">Jobs em paralelo</span>
              <input type="number" min={1} max={20} className="input w-full" value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))} />
              <span className="label text-xs">1 a 20. Vale após reiniciar.</span>
            </label>
            <label className="fieldset">
              <span className="fieldset-legend">Intervalo de busca (ms)</span>
              <input type="number" min={250} max={60000} step={250} className="input w-full" value={pollMs} onChange={(e) => setPollMs(Number(e.target.value))} />
              <span className="label text-xs">250 a 60000. Vale na hora.</span>
            </label>
            <label className="fieldset">
              <span className="fieldset-legend">Memória por CSV</span>
              <input className="input w-full font-mono" value={memory} onChange={(e) => setMemory(e.target.value)} pattern="[0-9]+(\.[0-9]+)?(MB|GB)" placeholder="1GB" />
              <span className="label text-xs">Ex.: 512MB, 1.5GB. Vale na hora.</span>
            </label>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" className="toggle toggle-sm" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Habilitado (o supervisor mantém este worker rodando)
          </label>
        </div>
        {error && <div role="alert" className="alert alert-error alert-soft mt-4 text-sm">{error}</div>}
        <div className="modal-action">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary btn-sm" disabled={saving}>{saving ? "Salvando…" : "Salvar"}</button>
        </div>
      </form>
    </dialog>
  );
}

function RestartDialog({ target, onClose, onConfirm }: { target: Profile | null; onClose: () => void; onConfirm: (mode: "SAFE" | "IMMEDIATE") => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [mode, setMode] = useState<"SAFE" | "IMMEDIATE">("SAFE");
  useEffect(() => { ref.current?.showModal(); }, []);
  const who = target ? `o worker "${target.name}"` : "todos os workers";
  return (
    <dialog ref={ref} className="modal" aria-labelledby={titleId} onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <div className="modal-box">
        <h3 id={titleId} className="text-lg font-bold">{target ? `Reiniciar ${target.name}` : "Reiniciar todos os workers"}</h3>
        <p className="mt-1 text-sm text-base-content/70">Como reiniciar {who}?</p>
        <div className="mt-4 space-y-2" role="radiogroup" aria-label="Modo de reinício">
          <label className={`flex cursor-pointer items-start gap-3 rounded-box border p-3 ${mode === "SAFE" ? "border-primary bg-primary/5" : "border-base-300"}`}>
            <input type="radio" name="restart-mode" className="radio radio-sm mt-0.5" checked={mode === "SAFE"} onChange={() => setMode("SAFE")} />
            <span className="text-sm"><span className="font-medium">Com segurança (recomendado)</span>
              <span className="block text-xs text-base-content/70">Para de pegar jobs novos, espera os que estão rodando terminarem (até o prazo configurado nesta tela) e então reinicia. Nenhum job é interrompido.</span></span>
          </label>
          <label className={`flex cursor-pointer items-start gap-3 rounded-box border p-3 ${mode === "IMMEDIATE" ? "border-error bg-error/5" : "border-base-300"}`}>
            <input type="radio" name="restart-mode" className="radio radio-sm radio-error mt-0.5" checked={mode === "IMMEDIATE"} onChange={() => setMode("IMMEDIATE")} />
            <span className="text-sm"><span className="font-medium">Agora</span>
              <span className="block text-xs text-base-content/70">Interrompe já. Os jobs em andamento voltam para a fila e recomeçam do início (uma tentativa é consumida).</span></span>
          </label>
        </div>
        <div className="modal-action">
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancelar</button>
          <button className={`btn btn-sm ${mode === "IMMEDIATE" ? "btn-error" : "btn-primary"}`} onClick={() => onConfirm(mode)}>{mode === "SAFE" ? "Reiniciar com segurança" : "Reiniciar agora"}</button>
        </div>
      </div>
    </dialog>
  );
}
