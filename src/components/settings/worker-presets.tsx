"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CircleAlert, RotateCw, SlidersHorizontal } from "lucide-react";
import { Panel } from "@/components/ui/primitives";
import { useFeedback } from "@/components/ui/feedback";
import { apiRequest, errorMessage } from "@/lib/api-client";
import {
  LANES, LANE_NAMES, PRESETS, describeEffective, detectPreset, diffCapacity, fmtNum, lanesConfigured, summarize, validateCapacity,
  type Capacity, type PresetId,
} from "@/lib/worker-presets";

type ProfileRow = { id: string; name: string; jobTypes: string[]; weights?: number[]; concurrency: number; enabled: boolean; runningJobs?: number; queuedJobs?: number };
type WorkersData = { supervisor: { supervised: boolean }; profiles: ProfileRow[] };
type Settings = { max_heavy_jobs: number; max_syncs_per_storage: number; import_batch_delay_ms: number; memory_limit_gb: number };


/**
 * Perfis de desempenho: um clique define slots dos workers + tetos + pausa (ver src/lib/worker-presets.ts).
 * O rótulo é DETECTADO dos valores atuais; editar qualquer número em "Personalizar" vira "Personalizado".
 */
export function WorkerPresets({ refreshKey = 0, onApplied, onCustomize }: { refreshKey?: number; onApplied?: () => void; onCustomize?: () => void }) {
  const { notify } = useFeedback();
  const [workers, setWorkers] = useState<WorkersData | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<PresetId | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [w, s] = await Promise.all([
        apiRequest<WorkersData>("/api/v1/workers"),
        apiRequest<Settings>("/api/v1/settings/worker"),
      ]);
      setWorkers(w.data); setSettings(s.data); setError("");
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    const id = window.setInterval(() => { if (!document.hidden) void load(); }, 5000);
    return () => { window.clearTimeout(first); window.clearInterval(id); };
  }, [load, refreshKey]);

  const current: Capacity | null = useMemo(() => {
    if (!workers || !settings) return null;
    return {
      slots: Object.fromEntries(workers.profiles.filter((p) => LANE_NAMES.includes(p.name)).map((p) => [p.name, p.concurrency])),
      lanes: lanesConfigured(workers.profiles.map((p) => ({ ...p, weights: p.weights ?? [] }))),
      max_heavy_jobs: settings.max_heavy_jobs,
      max_syncs_per_storage: settings.max_syncs_per_storage,
      import_batch_delay_ms: settings.import_batch_delay_ms,
    };
  }, [workers, settings]);

  if (!current || !workers || !settings) {
    return (
      <Panel title="Perfil de desempenho">
        <div className="p-6 text-center">{error ? <div role="alert" className="alert alert-error alert-soft">{error}</div> : <span className="loading loading-spinner" />}</div>
      </Panel>
    );
  }

  const detected = detectPreset(current);
  const preset = selected ? PRESETS.find((p) => p.id === selected)! : null;
  const rows = preset ? diffCapacity(current, preset.capacity) : [];
  const target = preset?.capacity ?? current;
  const summary = summarize(target);
  const validation = validateCapacity(target, settings.memory_limit_gb);
  const restartNames = [...new Set(rows.flatMap((r) => r.restart ?? []))];
  const supervised = workers.supervisor.supervised;

  async function apply(restart: boolean) {
    if (!preset) return;
    setBusy(true);
    try {
      const r = await apiRequest<{ preset: string }>("/api/v1/settings/worker/preset", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ preset: preset.id }),
      });
      const created = Array.isArray(r.meta?.newProfiles) ? (r.meta!.newProfiles as string[]) : [];
      const toRestart = Array.isArray(r.meta?.restartProfiles) ? (r.meta!.restartProfiles as string[]) : [];
      if (restart && toRestart.length > 0) {
        for (const name of toRestart) {
          const p = workers!.profiles.find((x) => x.name === name);
          if (!p) continue;
          await apiRequest("/api/v1/system/commands", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "RESTART_PROFILE", mode: "SAFE", profileId: p.id }),
          });
        }
        notify("success", `Perfil "${preset.label}" aplicado. Reinício seguro solicitado: os jobs em andamento terminam antes.${created.length ? " Faixas novas sobem sozinhas." : ""}`);
      } else {
        notify("success", toRestart.length > 0
          ? `Perfil "${preset.label}" salvo. Reinicie os workers (${toRestart.join(", ")}) para os novos slots valerem.`
          : `Perfil "${preset.label}" aplicado.`);
      }
      setSelected(null);
      await load();
      onApplied?.();
    } catch (e) {
      notify("error", errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Perfil de desempenho">
      <div className="space-y-5 p-5">
        <p className="text-sm text-base-content/70">
          Hoje na prática: <strong>{describeEffective(current)}</strong>
          {detected !== "custom" ? <> — perfil <strong>{PRESETS.find((p) => p.id === detected)!.label}</strong>.</> : <> — configuração <strong>personalizada</strong>.</>}
        </p>

        <div role="group" aria-label="Perfis de desempenho" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {PRESETS.map((p) => {
            const active = detected === p.id, chosen = selected === p.id;
            return (
              <button
                key={p.id}
                type="button"
                aria-pressed={chosen || (active && !selected)}
                onClick={() => setSelected(active ? null : p.id)}
                className={`flex flex-col items-start gap-1 rounded-xl border p-4 text-left transition-all ${
                  chosen ? "border-primary bg-primary/5 ring-2 ring-primary/40"
                    : active ? "border-success bg-success/5 ring-1 ring-success/30"
                    : "border-base-300 bg-base-100 hover:border-primary/30 hover:bg-base-200"}`}
              >
                <span className="flex w-full items-center justify-between gap-2">
                  <span className="text-sm font-semibold">{p.label}</span>
                  {active && <span className="badge badge-success badge-sm">em uso</span>}
                  {!active && p.recommended && <span className="badge badge-primary badge-outline badge-sm">recomendado</span>}
                </span>
                <span className="text-xs leading-snug text-base-content/65">{p.tagline}</span>
                <span className="mt-1 font-mono text-[11px] text-base-content/70">
                  {LANES.map((l) => p.capacity.slots[l.name]).join(" · ")} <span className="font-sans">(sync · longo · upload · pesado)</span>
                </span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={onCustomize}
            className={`flex flex-col items-start gap-1 rounded-xl border p-4 text-left transition-all ${
              detected === "custom" ? "border-success bg-success/5 ring-1 ring-success/30" : "border-base-300 bg-base-100 hover:border-primary/30 hover:bg-base-200"}`}
          >
            <span className="flex w-full items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-sm font-semibold"><SlidersHorizontal size={13} />Personalizado</span>
              {detected === "custom" && <span className="badge badge-success badge-sm">em uso</span>}
            </span>
            <span className="text-xs leading-snug text-base-content/65">Ajuste fino de cada número, para quem quer controlar tudo.</span>
          </button>
        </div>

        {preset && (
          <div className="space-y-3 rounded-xl border border-primary/30 bg-base-100 p-4" aria-live="polite">
            <h3 className="text-sm font-semibold">O que muda ao aplicar “{preset.label}”</h3>
            {rows.length === 0 ? (
              <p className="text-sm text-base-content/70">Nada muda: os valores atuais já são os deste perfil.</p>
            ) : (
              <table className="table table-sm">
                <thead><tr><th>Item</th><th className="text-right">Hoje</th><th className="text-right">Novo</th><th>Vale</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key}>
                      <td>{r.label}</td>
                      <td className="text-right font-mono">{r.fromText ?? r.from}{r.unit && r.unit !== "slots" ? ` ${r.unit}` : ""}</td>
                      <td className="text-right font-mono font-semibold">{r.toText ?? r.to}{r.unit && r.unit !== "slots" ? ` ${r.unit}` : ""}</td>
                      <td className="text-xs text-base-content/70">{r.createsProfile ? "sobe sozinho" : r.restart?.length ? "após reiniciar" : "em até 10 s"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <ul className="list-disc space-y-0.5 pl-5 text-sm text-base-content/75">
              <li>No máximo <strong>{summary.maxConcurrent}</strong> jobs ao mesmo tempo.</li>
              <li>Nunca mais que <strong>{summary.maxReadsPerStorage}</strong> {summary.maxReadsPerStorage === 1 ? "leitura simultânea" : "leituras simultâneas"} no mesmo storage.</li>
              <li>Memória estimada: ~{fmtNum(summary.memoryTypicalGb)} GB (pico ~{fmtNum(summary.memoryPeakGb)} GB){settings.memory_limit_gb > 0 ? <> · limite informado {fmtNum(settings.memory_limit_gb)} GB</> : <> · limite do container não informado</>}.</li>
            </ul>
            {validation.warnings.map((w) => (
              <div key={w} role="status" className="alert alert-warning alert-soft text-sm"><CircleAlert size={16} />{w}</div>
            ))}
            {validation.errors.map((e) => <div key={e} role="alert" className="alert alert-error alert-soft text-sm">{e}</div>)}
            <div className="flex flex-wrap justify-end gap-2">
              <button className="btn btn-ghost btn-sm" onClick={() => setSelected(null)} disabled={busy}>Cancelar</button>
              <button className="btn btn-sm" onClick={() => void apply(false)} disabled={busy || validation.errors.length > 0 || rows.length === 0}>Só salvar</button>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => void apply(true)}
                disabled={busy || validation.errors.length > 0 || rows.length === 0 || (restartNames.length > 0 && !supervised)}
                title={restartNames.length > 0 && !supervised ? "Nenhum supervisor ativo: só é possível salvar." : undefined}
              >
                <RotateCw size={14} className={busy ? "animate-spin" : ""} />
                {restartNames.length > 0 ? "Salvar e reiniciar com segurança" : "Aplicar"}
              </button>
            </div>
          </div>
        )}

        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-base-content/70">Capacidade agora</h3>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {LANES.map((lane) => {
              const p = workers.profiles.find((x) => x.name === lane.name);
              return (
                <div key={lane.name} className="rounded-lg border border-base-300 px-3 py-2 text-sm">
                  <div className="font-medium">{lane.label} <span className="text-xs font-normal text-base-content/70">{lane.hint}</span></div>
                  {p
                    ? <div className="text-base-content/70">rodando <strong>{p.runningJobs ?? 0}</strong> / {p.concurrency} · na fila <strong>{p.queuedJobs ?? 0}</strong>{!p.enabled ? " · desabilitado" : ""}</div>
                    : <div className="text-base-content/70">ainda não criada (um perfil de desempenho a cria)</div>}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </Panel>
  );
}
