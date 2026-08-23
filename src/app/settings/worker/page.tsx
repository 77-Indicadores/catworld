"use client";
import { useEffect, useState } from "react";
import { CheckCircle2, RefreshCw, Zap } from "lucide-react";
import { PageHeader, Panel } from "@/components/ui/primitives";

type Settings = {
  max_heavy_jobs: number;
  max_syncs_per_storage: number;
  import_batch_delay_ms: number;
  concurrency: number;
};

type Preset = {
  id: string;
  label: string;
  emoji: string;
  description: string;
  values: Omit<Settings, "concurrency">;
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
          <div className="text-xs text-base-content/55 mt-0.5">{description}</div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0 ml-6">
          <span className="font-mono text-sm font-semibold w-10 text-right">{value}</span>
          <span className="text-xs text-base-content/50">{unit}</span>
        </div>
      </div>
      <input
        type="range"
        className="range range-primary range-sm w-full"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {marks && (
        <div className="flex justify-between text-xs text-base-content/40 px-0.5">
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
    fetch("/api/v1/settings/worker")
      .then((r) => r.json())
      .then((b) => setSettings(b.data));
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
    const r = await fetch("/api/v1/settings/worker", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_heavy_jobs: settings.max_heavy_jobs,
        max_syncs_per_storage: settings.max_syncs_per_storage,
        import_batch_delay_ms: settings.import_batch_delay_ms,
      }),
    });
    setSaving(false);
    if (!r.ok) {
      const b = await r.json().catch(() => ({}));
      setError(b.error?.message ?? "Falha ao salvar");
    } else {
      setSaved(true);
    }
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
        title="Performance do Worker"
        description="Controla quantos jobs rodam em paralelo e com que intensidade. Mudanças entram em vigor em até 10 segundos, sem restart."
      />

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
                  <span className="text-xs text-base-content/55 leading-snug">{p.description}</span>
                </button>
              ))}
            </div>
            {activePreset === "custom" && (
              <p className="text-xs text-base-content/50">
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
              min={1} max={8}
              unit="jobs"
              marks={[1, 2, 4, 6, 8]}
            />
            <div className="divider my-0" />
            <SliderField
              label="Syncs por storage"
              description="Máximo de SOURCE_REFRESH simultâneos por servidor de armazenamento."
              value={settings.max_syncs_per_storage}
              onChange={(v) => set("max_syncs_per_storage", v)}
              min={1} max={8}
              unit="syncs"
              marks={[1, 2, 4, 6, 8]}
            />
            <div className="divider my-0" />
            <SliderField
              label="Pausa entre batches de import"
              description="Intervalo entre cada lote de 50.000 linhas. 0 ms = velocidade máxima. Aumentar reduz consumo de DTU/CPU no banco."
              value={settings.import_batch_delay_ms}
              onChange={(v) => set("import_batch_delay_ms", v)}
              min={0} max={1000} step={50}
              unit="ms"
              marks={[0, 250, 500, 750, 1000]}
            />
          </div>
        </Panel>

        {/* Info: concorrência */}
        <Panel>
          <div className="p-5 space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Loops de worker ativos</span>
              <span className="font-mono text-sm font-semibold">{settings.concurrency}</span>
            </div>
            <p className="text-xs text-base-content/50">
              Definido pela variável de ambiente <code className="font-mono">CATWORLD_WORKER_CONCURRENCY</code>. Requer restart do worker para alterar.
            </p>
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
            <li>O worker relê as configs do banco antes de cada job — mudanças entram em vigor em até 10 s.</li>
            <li><strong>Jobs pesados</strong>: imports e syncs pesam 2; o worker não inicia um novo se o limite for atingido.</li>
            <li><strong>Syncs por storage</strong>: evita que um storage seja bombardeado com muitos syncs simultâneos.</li>
            <li><strong>Pausa entre batches</strong>: reduz pico de DTU/CPU sem alterar o throughput médio de dados grandes.</li>
          </ul>
        </div>
      </Panel>
    </div>
  );
}
