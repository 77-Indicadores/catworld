"use client";
import { useEffect, useState } from "react";
import { CheckCircle2, RefreshCw } from "lucide-react";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { apiRequest, errorMessage } from "@/lib/api-client";
import { WorkersSection } from "@/components/settings/workers-section";
import { WorkerPresets } from "@/components/settings/worker-presets";

type Settings = {
  max_heavy_jobs: number;
  max_syncs_per_storage: number;
  import_batch_delay_ms: number;
  memory_limit_gb: number;
  upload_max_bytes: number;
  upload_xlsx_max_bytes: number;
  stop_timeout_ms: number;
  backoff_max_ms: number;
};

const MB = 1024 * 1024;

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
  const [customOpen, setCustomOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    apiRequest<Settings>("/api/v1/settings/worker")
      .then((r) => setSettings(r.data))
      .catch((e) => setError(errorMessage(e)));
  }, []);

  function set<K extends keyof Settings>(k: K, v: Settings[K]) {
    setSettings((s) => s ? { ...s, [k]: v } : s);
    setSaved(false);
  }

  /** Um preset foi aplicado no servidor: recarrega os campos abaixo para não ficarem com valores velhos. */
  function reloadSettings() {
    apiRequest<Settings>("/api/v1/settings/worker").then((r) => setSettings(r.data)).catch((e) => setError(errorMessage(e)));
    setRefreshKey((k) => k + 1);
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
          memory_limit_gb: settings.memory_limit_gb,
          upload_max_bytes: settings.upload_max_bytes,
          upload_xlsx_max_bytes: settings.upload_xlsx_max_bytes,
          stop_timeout_ms: settings.stop_timeout_ms,
          backoff_max_ms: settings.backoff_max_ms,
        }),
      });
      setSaved(true);
      setRefreshKey((k) => k + 1); // o bloco de perfis relê e re-detecta o perfil em uso
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

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Configurações"
        title="Workers"
        description="Escolha um perfil de desempenho. Quem quiser controlar cada número abre “Personalizar”. Tudo é configurado aqui; nenhuma variável de ambiente é usada."
      />

      <WorkerPresets refreshKey={refreshKey} onApplied={reloadSettings} onCustomize={() => setCustomOpen(true)} />

      <details
        open={customOpen}
        onToggle={(e) => setCustomOpen((e.currentTarget as HTMLDetailsElement).open)}
        className="group rounded-box border border-base-300 bg-base-100"
      >
        <summary className="cursor-pointer select-none px-5 py-3 text-sm font-semibold">
          Personalizar <span className="ml-1 font-normal text-base-content/65">— workers, limites e proteções (para quem quer ajustar cada número)</span>
        </summary>
        <div className="space-y-6 border-t border-base-300 p-4">

      <WorkersSection />

      {saved && (
        <div className="alert alert-success alert-soft">
          <CheckCircle2 size={18} /> Configurações salvas. Cada worker aplica no seu próximo ciclo de verificação (intervalo configurável por perfil, alguns segundos por padrão).
        </div>
      )}
      {error && <div className="alert alert-error alert-soft">{error}</div>}

      <form onSubmit={save} className="space-y-4">
        {/* Proteções (tetos globais) */}
        <Panel>
          <div className="p-5 space-y-6">
            <h2 className="font-semibold text-sm text-base-content/70 uppercase tracking-wide">Proteções</h2>
            <p className="text-xs text-base-content/65">
              Tetos que valem para todos os workers juntos. Quantos jobs cada worker roda ao mesmo tempo são os <strong>slots</strong> (tabela acima);
              o paralelismo real é o <strong>menor</strong> entre o slot e o teto.
            </p>

            <SliderField
              label="Teto de jobs pesados"
              description="Imports e syncs completos (peso 2) ao mesmo tempo, somando todos os workers. Deixe pelo menos igual aos slots de sync, senão os syncs completos rodam um de cada vez."
              value={settings.max_heavy_jobs}
              onChange={(v) => set("max_heavy_jobs", v)}
              min={1} max={20}
              unit="jobs"
              marks={[1, 5, 10, 15, 20]}
            />
            <div className="divider my-0" />
            <SliderField
              label="Leituras simultâneas por storage"
              description="Quantos syncs de fonte podem ler o mesmo servidor ao mesmo tempo (protege ERPs e storages). Também limitado pelos slots de sync."
              value={settings.max_syncs_per_storage}
              onChange={(v) => set("max_syncs_per_storage", v)}
              min={1} max={20}
              unit="leituras"
              marks={[1, 5, 10, 15, 20]}
            />
            <div className="divider my-0" />
            <SliderField
              label="Pausa entre lotes de import"
              description="Intervalo entre cada lote de 50.000 linhas. 0 ms = velocidade máxima. Aumentar reduz consumo de DTU/CPU no banco."
              value={settings.import_batch_delay_ms}
              onChange={(v) => set("import_batch_delay_ms", v)}
              min={0} max={5000} step={50}
              unit="ms"
              marks={[0, 1000, 2500, 5000]}
            />
            <div className="divider my-0" />
            <SliderField
              label="Memória do container dos workers"
              description="Só para AVISO: se a memória de pico estimada dos perfis passar deste valor, a tela avisa. 0 = não informado."
              value={settings.memory_limit_gb}
              onChange={(v) => set("memory_limit_gb", v)}
              min={0} max={128}
              unit="GB"
              marks={[0, 32, 64, 96, 128]}
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
            <li><strong>Slots</strong> (tabela de workers): quantos jobs cada worker roda ao mesmo tempo. Só valem depois de reiniciar o worker. Os tetos abaixo valem sem reiniciar, no próximo ciclo de verificação de cada worker (o intervalo é configurável por perfil — normalmente alguns segundos, mas pode ser maior).</li>
            <li>O paralelismo real é o <strong>menor</strong> entre os slots e os tetos: um teto acima dos slots não tem efeito.</li>
            <li><strong>Reiniciar com segurança</strong> espera os jobs em andamento terminarem; <strong>reiniciar agora</strong> interrompe e os jobs recomeçam.</li>
            <li><strong>Teto de jobs pesados</strong>: imports e syncs completos pesam 2; o worker não inicia um novo se o teto for atingido.</li>
            <li><strong>Leituras por storage</strong>: evita que um storage ou ERP seja bombardeado com muitos syncs simultâneos.</li>
            <li><strong>Pausa entre lotes</strong>: reduz pico de DTU/CPU sem alterar o throughput médio de dados grandes.</li>
          </ul>
        </div>
      </Panel>
        </div>
      </details>
    </div>
  );
}
