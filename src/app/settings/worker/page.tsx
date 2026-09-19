"use client";
import { useEffect, useState } from "react";
import { CheckCircle2, RefreshCw, Zap } from "lucide-react";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { apiRequest, errorMessage } from "@/lib/api-client";
import { WorkersSection } from "@/components/settings/workers-section";

type Settings = {
  max_heavy_jobs: number;
  max_syncs_per_storage: number;
  import_batch_delay_ms: number;
  upload_max_bytes: number;
  upload_xlsx_max_bytes: number;
  stop_timeout_ms: number;
  backoff_max_ms: number;
};

const MB = 1024 * 1024;

type Preset = {
  id: string;
  label: string;
  emoji: string;
  description: string;
  values: Pick<Settings, "max_heavy_jobs" | "max_syncs_per_storage" | "import_batch_delay_ms">;
};

const PRESETS: Preset[] = [
  {
    id: "economico",
    label: "Econômico",
    emoji: "🐢",
    description: "Banco sob pressão — API sempre responsiva, syncs lentos.",
    values: { max_heavy_jobs: 1, max_syncs_per_storage: 1, import_batch_delay_ms: 500 },
  },
  {
    id: "balanceado",
    label: "Balanceado",
    emoji: "⚖️",
    description: "Uso geral — boa performance sem sobrecarregar o banco.",
    values: { max_heavy_jobs: 2, max_syncs_per_storage: 2, import_batch_delay_ms: 150 },
  },
  {
    id: "maximo",
    label: "Máximo",
    emoji: "🚀",
    description: "Banco robusto — processa tudo o mais rápido possível.",
    values: { max_heavy_jobs: 4, max_syncs_per_storage: 4, import_batch_delay_ms: 0 },
  },
];

function detectPreset(s: Settings): string {
  for (const p of PRESETS) {
    if (
      p.values.max_heavy_jobs === s.max_heavy_jobs &&
      p.values.max_syncs_per_storage === s.max_syncs_per_storage &&
      p.values.import_batch_delay_ms === s.import_batch_delay_ms
    ) return p.id;
  }
  return "custom";
}

function SliderField({
  label,
  description,
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
  marks,
}: {
  label: string;
  description: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  unit: string;
  marks?: number[];
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-medium text-sm">{label}</div>
          <div className="text-xs text-base-content/65 mt-0.5">{description}</div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0 ml-6">
          <input
            type="number"
            aria-label={`${label} (${unit})`}
            className="input input-bordered input-xs w-20 text-right font-mono font-semibold"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, Math.round(n)))); }}
          />
          <span className="text-xs text-base-content/65">{unit}</span>
        </div>
      </div>
      <input
        type="range"
        aria-label={label}
        aria-valuetext={`${value} ${unit}`}
        className="range range-primary range-sm w-full"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {marks && (
        <div className="flex justify-between text-xs text-base-content/65 px-0.5">
          {marks.map((m) => <span key={m}>{m}</span>)}
        </div>
      )}
    </div>
  );
}

export default function WorkerPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    apiRequest<Settings>("/api/v1/settings/worker")
      .then((r) => setSettings(r.data))
      .catch((e) => setError(errorMessage(e)));
  }, []);

  function set<K extends keyof Settings>(k: K, v: Settings[K]) {
    setSettings((s) => s ? { ...s, [k]: v } : s);
    setSaved(false);
  }

  function applyPreset(presetId: string) {
    const p = PRESETS.find((p) => p.id === presetId);
    if (!p) return;
    setSettings((s) => s ? { ...s, ...p.values } : s);
    setSaved(false);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!settings) return;
    setSaving(true); setError(""); setSaved(false);
    try {
      await apiRequest("/api/v1/settings/worker", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          max_heavy_jobs: settings.max_heavy_jobs,
          max_syncs_per_storage: settings.max_syncs_per_storage,
          import_batch_delay_ms: settings.import_batch_delay_ms,
          upload_max_bytes: settings.upload_max_bytes,
          upload_xlsx_max_bytes: settings.upload_xlsx_max_bytes,
          stop_timeout_ms: settings.stop_timeout_ms,
          backoff_max_ms: settings.backoff_max_ms,
        }),
      });
      setSaved(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  if (!settings && error) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Configurações" title="Performance do Worker" />
        <div role="alert" className="alert alert-error alert-soft">{error}</div>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Configurações" title="Performance do Worker" description="Controla quantos jobs podem rodar em paralelo e com que intensidade." />
        <div className="rounded-box border border-base-300 bg-base-100 p-10 text-center">
          <span className="loading loading-spinner" />
        </div>
      </div>
    );
  }

  const activePreset = detectPreset(settings);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Configurações"
        title="Workers"
        description="Quais workers rodam e o que cada um processa, com que intensidade e quando reiniciar. Tudo é configurado aqui; nenhuma variável de ambiente é usada."
      />

      <WorkersSection />

      {saved && (
        <div className="alert alert-success alert-soft">
          <CheckCircle2 size={18} /> Configurações salvas. O worker vai aplicar em até 10 segundos.
        </div>
      )}
      {error && <div className="alert alert-error alert-soft">{error}</div>}

      <form onSubmit={save} className="space-y-4">
        {/* Presets */}
        <Panel>
          <div className="p-5 space-y-4">
            <h2 className="font-semibold text-sm text-base-content/70 uppercase tracking-wide">Perfil</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => applyPreset(p.id)}
                  className={`flex flex-col items-start gap-1 rounded-xl border p-4 text-left transition-all ${
                    activePreset === p.id
                      ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                      : "border-base-300 bg-base-100 hover:border-primary/30 hover:bg-base-200"
                  }`}
                >
                  <span className="text-2xl leading-none">{p.emoji}</span>
                  <span className="font-semibold text-sm mt-1">{p.label}</span>
                  <span className="text-xs text-base-content/65 leading-snug">{p.description}</span>
                </button>
              ))}
            </div>
            {activePreset === "custom" && (
              <p className="text-xs text-base-content/65">
                <Zap size={12} className="inline mr-1" />
                Configuração personalizada — ajuste os controles abaixo.
              </p>
            )}
          </div>
        </Panel>

        {/* Sliders */}
        <Panel>
          <div className="p-5 space-y-6">
            <h2 className="font-semibold text-sm text-base-content/70 uppercase tracking-wide">Controles</h2>

            <SliderField
              label="Jobs pesados simultâneos"
              description="Imports e syncs de fonte (peso 2). Inclui uploads e SOURCE_REFRESH."
              value={settings.max_heavy_jobs}
              onChange={(v) => set("max_heavy_jobs", v)}
              min={1} max={20}
              unit="jobs"
              marks={[1, 5, 10, 15, 20]}
            />
            <div className="divider my-0" />
            <SliderField
              label="Syncs por storage"
              description="Máximo de SOURCE_REFRESH simultâneos por servidor de armazenamento."
              value={settings.max_syncs_per_storage}
              onChange={(v) => set("max_syncs_per_storage", v)}
              min={1} max={20}
              unit="syncs"
              marks={[1, 5, 10, 15, 20]}
            />
            <div className="divider my-0" />
            <SliderField
              label="Pausa entre batches de import"
              description="Intervalo entre cada lote de 50.000 linhas. 0 ms = velocidade máxima. Aumentar reduz consumo de DTU/CPU no banco."
              value={settings.import_batch_delay_ms}
              onChange={(v) => set("import_batch_delay_ms", v)}
              min={0} max={5000} step={50}
              unit="ms"
              marks={[0, 1000, 2500, 5000]}
            />
          </div>
        </Panel>

        {/* Limites de upload */}
        <Panel>
          <div className="p-5 space-y-4">
            <h2 className="font-semibold text-sm text-base-content/70 uppercase tracking-wide">Limites de upload</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="fieldset">
                <span className="fieldset-legend">Tamanho máximo do arquivo (MB)</span>
                <input type="number" min={1} max={2048} className="input w-full" value={Math.round(settings.upload_max_bytes / MB)} onChange={(e) => set("upload_max_bytes", Math.min(2048, Math.max(1, Number(e.target.value))) * MB)} />
                <span className="label text-xs">Vale a partir do próximo envio. Máximo 2048 MB.</span>
              </label>
              <label className="fieldset">
                <span className="fieldset-legend">Máximo para Excel (MB)</span>
                <input type="number" min={1} max={2048} className="input w-full" value={Math.round(settings.upload_xlsx_max_bytes / MB)} onChange={(e) => set("upload_xlsx_max_bytes", Math.min(2048, Math.max(1, Number(e.target.value))) * MB)} />
                <span className="label text-xs">Excel é lido inteiro na memória (cerca de 35 vezes o tamanho do arquivo). Prefira CSV para arquivos grandes.</span>
              </label>
            </div>
          </div>
        </Panel>

        {/* Reinício e recuperação */}
        <Panel>
          <div className="p-5 space-y-4">
            <h2 className="font-semibold text-sm text-base-content/70 uppercase tracking-wide">Reinício e recuperação</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="fieldset">
                <span className="fieldset-legend">Prazo do reinício seguro (minutos)</span>
                <input type="number" min={1} max={60} className="input w-full" value={Math.round(settings.stop_timeout_ms / 60000)} onChange={(e) => set("stop_timeout_ms", Math.min(60, Math.max(1, Number(e.target.value))) * 60000)} />
                <span className="label text-xs">Quanto esperar os jobs terminarem antes de forçar a parada. Passado o prazo, os jobs voltam para a fila.</span>
              </label>
              <label className="fieldset">
                <span className="fieldset-legend">Espera máxima após uma falha (segundos)</span>
                <input type="number" min={1} max={600} className="input w-full" value={Math.round(settings.backoff_max_ms / 1000)} onChange={(e) => set("backoff_max_ms", Math.min(600, Math.max(1, Number(e.target.value))) * 1000)} />
                <span className="label text-xs">Um worker que cai é reiniciado com espera crescente (1 s, 2 s, 4 s…) até este limite.</span>
              </label>
            </div>
          </div>
        </Panel>

        <div className="flex justify-end">
          <button type="submit" disabled={saving} className="btn btn-primary btn-sm">
            <RefreshCw size={14} className={saving ? "animate-spin" : ""} />
            {saving ? "Salvando..." : "Salvar configurações"}
          </button>
        </div>
      </form>

      {/* Como funciona */}
      <Panel>
        <div className="p-5 space-y-2">
          <h2 className="font-semibold text-sm text-base-content/70 uppercase tracking-wide">Como funciona</h2>
          <ul className="text-sm text-base-content/65 space-y-1 list-disc list-inside">
            <li>Estes limites e o intervalo de busca/memória de cada worker valem em até 10 s, sem reiniciar. Tipos de job e paralelismo de um worker só valem depois de reiniciá-lo.</li>
            <li><strong>Reiniciar com segurança</strong> espera os jobs em andamento terminarem; <strong>reiniciar agora</strong> interrompe e os jobs recomeçam.</li>
            <li><strong>Jobs pesados</strong>: imports e syncs pesam 2; o worker não inicia um novo se o limite for atingido.</li>
            <li><strong>Syncs por storage</strong>: evita que um storage seja bombardeado com muitos syncs simultâneos.</li>
            <li><strong>Pausa entre batches</strong>: reduz pico de DTU/CPU sem alterar o throughput médio de dados grandes.</li>
          </ul>
        </div>
      </Panel>
    </div>
  );
}
