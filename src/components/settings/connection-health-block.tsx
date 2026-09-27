"use client";
import { useEffect, useState } from "react";
import { StatusBadge } from "@/components/ui/primitives";
import { Time } from "@/components/ui/time";
import { apiRequest, errorMessage } from "@/lib/api-client";
import { fmtDuration } from "@/lib/fmt";
import type { ConnectionHealth, HealthCheckRow } from "@/server/connections/health";

const KIND_LABEL: Record<string, string> = { poll: "Verificação automática", test: "Teste manual" };
const OUTCOME_LABEL: Record<string, string> = { unchanged: "Sem mudança", changed: "Mudança detectada", healthy: "Saudável", error: "Erro" };

function outcomeTone(outcome: string): "healthy" | "error" | "inactive" {
  if (outcome === "error") return "error";
  if (outcome === "changed" || outcome === "healthy") return "healthy";
  return "inactive";
}

function CheckRow({ c }: { c: HealthCheckRow }) {
  return (
    <li className="flex flex-col gap-0.5 border-b border-base-300 py-2 last:border-0">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{KIND_LABEL[c.kind] ?? c.kind}</span>
        <StatusBadge status={outcomeTone(c.outcome)} label={OUTCOME_LABEL[c.outcome] ?? c.outcome} />
      </div>
      <p className="text-base-content/70">
        <Time iso={c.createdAt} relative />
        {c.latencyMs !== null && ` · ${c.latencyMs} ms`}
      </p>
      {c.outcome === "error" && c.errorMessage && <p className="break-words font-mono text-[11px] text-error">{c.errorMessage}</p>}
    </li>
  );
}

function HealthContent({ data }: { data: ConnectionHealth }) {
  return (
    <div className="space-y-4">
      {data.rollup.avgSourceDurationMs !== null && (
        <p className="text-base-content/70">Média das últimas execuções: <span className="font-medium text-base-content">{fmtDuration(data.rollup.avgSourceDurationMs)}</span></p>
      )}
      {data.sources.length > 0 && (
        <div>
          <h5 className="mb-1 font-semibold">Fontes</h5>
          <ul>
            {data.sources.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2 border-b border-base-300 py-1.5 last:border-0">
                <span>{s.name}</span>
                <span className="text-base-content/70">
                  {s.avgDurationMsFromMetrics !== null ? fmtDuration(s.avgDurationMsFromMetrics) : "—"}
                  {s.avgRunMs !== null && ` · EMA ${fmtDuration(s.avgRunMs)}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <h5 className="mb-1 font-semibold">Verificações recentes</h5>
        {data.checks.length === 0
          ? <p className="text-base-content/70">Nenhuma verificação registrada ainda.</p>
          : <ul>{data.checks.map((c) => <CheckRow key={c.id} c={c} />)}</ul>}
      </div>
    </div>
  );
}

function useConnectionHealth(url: string) {
  const [data, setData] = useState<ConnectionHealth | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  async function load() {
    if (data || loading) return;
    setLoading(true);
    setError("");
    try {
      setData((await apiRequest<ConnectionHealth>(url)).data ?? null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }
  return { data, error, loading, load };
}

type Subject = { connectionId: string; storageServerId?: undefined } | { connectionId?: undefined; storageServerId: string };

/**
 * Bloco "Saúde": histórico de health-check (polls automáticos + testes manuais) e duração média de
 * sync por fonte. Storage servers não têm fontes, então `sources`/`avgSourceDurationMs` ficam vazios/nulos.
 * `variant="details"` (padrão): disclosure própria, carrega ao abrir (mesmo padrão de HistoryBlock).
 * `variant="bare"`: sem wrapper, carrega ao montar — para embutir num dropdown que já controla a abertura.
 */
export function ConnectionHealthBlock({ variant = "details", ...subject }: Subject & { variant?: "details" | "bare" }) {
  const url = subject.connectionId ? `/api/v1/connections/${subject.connectionId}/health` : `/api/v1/storage-servers/${subject.storageServerId}/health`;
  const { data, error, loading, load } = useConnectionHealth(url);

  useEffect(() => {
    if (variant === "bare") void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, variant]);

  if (variant === "bare") {
    return (
      <div className="text-xs" aria-live="polite">
        {loading && <span className="loading loading-spinner loading-xs" aria-label="Carregando saúde" />}
        {error && <div role="alert" className="alert alert-error alert-soft text-xs">{error}</div>}
        {data && <HealthContent data={data} />}
      </div>
    );
  }

  return (
    <details className="mt-3" onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open) void load(); }}>
      <summary className="cursor-pointer text-[11px] font-semibold text-base-content/70">Saúde e histórico de verificações</summary>
      <div className="mt-3 text-xs" aria-live="polite">
        {loading && <span className="loading loading-spinner loading-xs" aria-label="Carregando saúde" />}
        {error && <div role="alert" className="alert alert-error alert-soft text-xs">{error}</div>}
        {data && <HealthContent data={data} />}
      </div>
    </details>
  );
}
