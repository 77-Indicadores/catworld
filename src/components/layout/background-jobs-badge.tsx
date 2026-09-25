"use client";
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/api-client";

type ActiveJob = { id: string; type: string; status: string; label: string; attempts: number; createdAt: string };

const POLL_MS = 8000;

/**
 * Indicador global de jobs pesados em background (hoje: migração de storage) — mora no
 * header, não numa tela dedicada, porque o requisito é o usuário saber que algo está
 * rodando sem precisar ficar numa "tela de processamento" olhando pra ela.
 */
export function BackgroundJobsBadge({ enabled }: { enabled: boolean }) {
  const [jobs, setJobs] = useState<ActiveJob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const poll = () => {
      apiRequest<{ jobs: ActiveJob[] }>("/api/v1/jobs/active")
        .then(({ data }) => { if (!cancelled) setJobs(data?.jobs ?? []); })
        // silencioso: um indicador de fundo não deve gerar ruído/toast por causa de um poll que falhou
        .catch(() => undefined);
    };
    poll();
    timerRef.current = setInterval(poll, POLL_MS);
    return () => { cancelled = true; if (timerRef.current) clearInterval(timerRef.current); };
  }, [enabled]);

  if (!enabled || jobs.length === 0) return null;

  const running = jobs.filter(j => j.status === "RUNNING").length;
  const queued = jobs.length - running;

  return (
    <div className="dropdown dropdown-end">
      <button tabIndex={0} className="btn btn-ghost btn-sm gap-2" aria-label={`${jobs.length} operação(ões) em background`}>
        <Loader2 size={16} className="animate-spin text-primary" />
        <span className="hidden sm:inline text-xs">{jobs.length} em andamento</span>
      </button>
      <div tabIndex={0} className="dropdown-content z-50 mt-2 w-80 rounded-box border border-base-300 bg-base-100 p-3 shadow-xl">
        <p className="text-xs font-medium text-base-content/70">
          {running > 0 && `${running} rodando`}{running > 0 && queued > 0 && " · "}{queued > 0 && `${queued} na fila`}
        </p>
        <ul className="mt-2 space-y-2">
          {jobs.map(j => (
            <li key={j.id} className="flex items-start gap-2 text-xs">
              <span className={`badge badge-xs mt-0.5 ${j.status === "RUNNING" ? "badge-primary" : "badge-ghost"}`}>{j.status === "RUNNING" ? "rodando" : "na fila"}</span>
              <span className="min-w-0 flex-1 truncate" title={j.label}>{j.label}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
