"use client";
import { useEffect, useState } from "react";
import { CheckCircle2, Trash2, RefreshCw } from "lucide-react";
import { PageHeader, Panel } from "@/components/ui/primitives";

type Settings = {
  jobs_days: number;
  audit_events_days: number;
  uploads_days: number;
  dataset_versions_keep: number;
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

export default function RetentionPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [purging, setPurging] = useState(false);
  const [purgeOk, setPurgeOk] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/v1/settings/retention")
      .then((r) => r.json())
      .then((b) => setSettings(b.data));
  }, []);

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

      <Panel>
        <div className="p-5 space-y-2">
          <h2 className="font-semibold text-sm text-base-content/70 uppercase tracking-wide">Como funciona</h2>
          <ul className="text-sm text-base-content/65 space-y-1 list-disc list-inside">
            <li>O worker executa a limpeza automaticamente a cada 24 horas via job <code className="font-mono text-xs">METADATA_CLEANUP</code>.</li>
            <li>Use "Purgar agora" para forçar a limpeza imediatamente (enfileira um job).</li>
            <li>Dados de datasets (tabelas SQL Server) nunca são afetados — apenas metadados internos.</li>
            <li>A janela de retenção conta a partir de <code className="font-mono text-xs">created_at</code> de cada registro.</li>
          </ul>
        </div>
      </Panel>
    </div>
  );
}
