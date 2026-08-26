"use client";
import { useEffect, useState, useCallback } from "react";
import { CheckCircle2, Trash2, RefreshCw, Clock, AlertCircle } from "lucide-react";
import { PageHeader, Panel } from "@/components/ui/primitives";

type Settings = {
  jobs_days: number;
  audit_events_days: number;
  uploads_days: number;
  dataset_versions_keep: number;
};

type CleanupRun = {
  id: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  deleted_jobs: number;
  deleted_audit: number;
  deleted_uploads: number;
  deleted_files: number;
  deleted_orphans: number;
  deleted_versions: number;
  error: string | null;
};

function NumberField({
  label,
  description,
  name,
  value,
  onChange,
  min = 1,
  max = 3650,
  unit = "dias",
}: {
  label: string;
  description: string;
  name: keyof Settings;
  value: number;
  onChange: (k: keyof Settings, v: number) => void;
  min?: number;
  max?: number;
  unit?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="flex-1">
        <div className="font-medium text-sm">{label}</div>
        <div className="text-xs text-base-content/55 mt-0.5">{description}</div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <input
          type="number"
          className="input input-sm w-24 text-right"
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(name, Number(e.target.value))}
        />
        <span className="text-sm text-base-content/60 w-10">{unit}</span>
      </div>
    </div>
  );
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

function fmtDuration(ms: number | null) {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function RunRow({ run }: { run: CleanupRun }) {
  const failed = !!run.error;
  const running = !run.finished_at && !run.error;
  const total = run.deleted_jobs + run.deleted_audit + run.deleted_uploads + run.deleted_versions;

  return (
    <tr className="text-xs">
      <td className="py-2 pr-4 whitespace-nowrap text-base-content/70">
        {fmtDate(run.started_at)}
      </td>
      <td className="py-2 pr-4">
        {running ? (
          <span className="badge badge-sm badge-warning badge-soft">rodando</span>
        ) : failed ? (
          <span className="badge badge-sm badge-error badge-soft flex items-center gap-1">
            <AlertCircle size={10} /> erro
          </span>
        ) : (
          <span className="badge badge-sm badge-success badge-soft">ok</span>
        )}
      </td>
      <td className="py-2 pr-4 text-base-content/60">{fmtDuration(run.duration_ms)}</td>
      <td className="py-2 pr-4 tabular-nums">
        {failed ? (
          <span className="text-error text-xs truncate max-w-[200px] block" title={run.error ?? ""}>
            {run.error}
          </span>
        ) : (
          <span className="text-base-content/80">
            {total > 0 ? `${total} linhas` : "nada"}
          </span>
        )}
      </td>
      <td className="py-2 text-base-content/50 text-right tabular-nums">
        {!failed && (
          <span title={`jobs=${run.deleted_jobs} audit=${run.deleted_audit} uploads=${run.deleted_uploads} arquivos=${run.deleted_files} órfãos=${run.deleted_orphans} versões=${run.deleted_versions}`}>
            j{run.deleted_jobs} · a{run.deleted_audit} · u{run.deleted_uploads} · v{run.deleted_versions}
          </span>
        )}
      </td>
    </tr>
  );
}

export default function RetentionPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [history, setHistory] = useState<CleanupRun[]>([]);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [purging, setPurging] = useState(false);
  const [purgeOk, setPurgeOk] = useState(false);
  const [error, setError] = useState("");

  const loadHistory = useCallback(() => {
    fetch("/api/v1/settings/retention/history")
      .then((r) => r.json())
      .then((b) => Array.isArray(b.data) && setHistory(b.data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/v1/settings/retention")
      .then((r) => r.json())
      .then((b) => setSettings(b.data));
    loadHistory();
  }, [loadHistory]);

  function set(k: keyof Settings, v: number) {
    setSettings((s) => s ? { ...s, [k]: v } : s);
    setSaved(false);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!settings) return;
    setSaving(true); setError(""); setSaved(false);
    const r = await fetch("/api/v1/settings/retention", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(settings),
    });
    setSaving(false);
    if (!r.ok) {
      const b = await r.json().catch(() => ({}));
      setError(b.error?.message ?? "Falha ao salvar");
    } else {
      setSaved(true);
    }
  }

  async function purge() {
    if (!confirm("Isso vai deletar registros além do período de retenção agora. Confirma?")) return;
    setPurging(true); setPurgeOk(false); setError("");
    const r = await fetch("/api/v1/settings/retention/purge", { method: "POST" });
    setPurging(false);
    if (!r.ok) {
      const b = await r.json().catch(() => ({}));
      setError(b.error?.message ?? "Falha ao enfileirar purga");
    } else {
      setPurgeOk(true);
      setTimeout(loadHistory, 1500);
    }
  }

  if (!settings) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Configurações" title="Retenção de metadados" description="Controla por quanto tempo dados internos são mantidos no banco." />
        <div className="rounded-box border border-base-300 bg-base-100 p-10 text-center"><span className="loading loading-spinner" /></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Configurações"
        title="Retenção de metadados"
        description="Controla por quanto tempo dados internos (jobs, auditoria, uploads) são mantidos. O worker limpa automaticamente registros fora da janela."
      />

      {saved && (
        <div className="alert alert-success alert-soft">
          <CheckCircle2 size={18} /> Configurações salvas.
        </div>
      )}
      {purgeOk && (
        <div className="alert alert-success alert-soft">
          <CheckCircle2 size={18} /> Job de limpeza enfileirado. Os registros serão removidos em breve.
        </div>
      )}
      {error && <div className="alert alert-error alert-soft">{error}</div>}

      <form onSubmit={save} className="space-y-4">
        <Panel>
          <div className="p-5 space-y-5">
            <h2 className="font-semibold text-sm text-base-content/70 uppercase tracking-wide">Janelas de retenção</h2>

            <NumberField
              label="Jobs (cw_jobs)"
              description="Remove jobs COMPLETED e FAILED mais antigos que N dias. ~2.600 registros/dia em produção."
              name="jobs_days"
              value={settings.jobs_days}
              onChange={set}
            />
            <div className="divider my-0" />
            <NumberField
              label="Eventos de auditoria (cw_audit_events)"
              description="Remove todos os eventos de auditoria mais antigos que N dias. ~2.500 registros/dia."
              name="audit_events_days"
              value={settings.audit_events_days}
              onChange={set}
            />
            <div className="divider my-0" />
            <NumberField
              label="Uploads (cw_uploads)"
              description="Remove uploads COMPLETED, FAILED e CANCELLED mais antigos que N dias. ~960 registros/dia."
              name="uploads_days"
              value={settings.uploads_days}
              onChange={set}
            />
            <div className="divider my-0" />
            <NumberField
              label="Versões por tabela (cw_dataset_versions)"
              description="Mantém apenas as N versões mais recentes por tabela de dataset. Versões excedentes são removidas na próxima limpeza."
              name="dataset_versions_keep"
              value={settings.dataset_versions_keep}
              onChange={set}
              min={1}
              max={1000}
              unit="versões"
            />
          </div>
        </Panel>

        <div className="flex items-center justify-between gap-4">
          <button
            type="button"
            disabled={purging}
            onClick={purge}
            className="btn btn-outline btn-error btn-sm"
          >
            <Trash2 size={14} className={purging ? "animate-pulse" : ""} />
            {purging ? "Enfileirando..." : "Purgar agora"}
          </button>
          <button type="submit" disabled={saving} className="btn btn-primary btn-sm">
            <RefreshCw size={14} className={saving ? "animate-spin" : ""} />
            {saving ? "Salvando..." : "Salvar configurações"}
          </button>
        </div>
      </form>

      {/* Histórico de execuções */}
      <Panel>
        <div className="p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-sm text-base-content/70 uppercase tracking-wide">Histórico de limpeza</h2>
            <button type="button" onClick={loadHistory} className="btn btn-ghost btn-xs">
              <RefreshCw size={12} /> Atualizar
            </button>
          </div>
          {history.length === 0 ? (
            <p className="text-sm text-base-content/50 py-4 text-center">Nenhuma execução registrada ainda.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-xs text-base-content/50 border-b border-base-200">
                    <th className="pb-2 pr-4 text-left font-medium">Início</th>
                    <th className="pb-2 pr-4 text-left font-medium">Status</th>
                    <th className="pb-2 pr-4 text-left font-medium">Duração</th>
                    <th className="pb-2 pr-4 text-left font-medium">Resultado</th>
                    <th className="pb-2 text-right font-medium">Detalhes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-base-200">
                  {history.map((run) => <RunRow key={run.id} run={run} />)}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Panel>

      <Panel>
        <div className="p-5 space-y-2">
          <h2 className="font-semibold text-sm text-base-content/70 uppercase tracking-wide">Como funciona</h2>
          <ul className="text-sm text-base-content/65 space-y-1 list-disc list-inside">
            <li>O worker executa a limpeza automaticamente a cada 24 horas via job <code className="font-mono text-xs">METADATA_CLEANUP</code>.</li>
            <li>Use "Purgar agora" para forçar a limpeza imediatamente (enfileira um job).</li>
            <li>Dados de datasets (tabelas SQL Server) nunca são afetados — apenas metadados internos.</li>
            <li>A janela de retenção conta a partir de <code className="font-mono text-xs">created_at</code> de cada registro.</li>
            <li>Os detalhes de cada execução ficam no histórico: <code className="font-mono text-xs">j=jobs · a=audit · u=uploads · v=versões</code>.</li>
          </ul>
        </div>
      </Panel>
    </div>
  );
}
