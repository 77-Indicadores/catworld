"use client";

import { CheckCircle2, CircleX, Clock3, DatabaseZap, Loader2 } from "lucide-react";
import { fmtRelative, fmtDuration } from "@/lib/fmt";

export type SourceRefreshWithSource = {
  id: string;
  status: string;
  lockedBy: string | null;
  lastError: string | null;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
  updatedAt: Date;
  source: {
    id: string;
    name: string;
    dataset: {
      id: string;
      name: string;
      project: { id: string; name: string };
    };
  } | null;
};


const STATUS_CONFIG: Record<string, { cls: string; icon: React.ElementType; label: string }> = {
  QUEUED:  { cls: "badge-ghost",   icon: Clock3,       label: "Aguardando" },
  RUNNING: { cls: "badge-info",    icon: Loader2,      label: "Em andamento" },
  DONE:    { cls: "badge-success", icon: CheckCircle2, label: "Concluído" },
  FAILED:  { cls: "badge-error",   icon: CircleX,      label: "Falhou" },
};

export function SourceRefreshCard({ job }: { job: SourceRefreshWithSource }) {
  const cfg = STATUS_CONFIG[job.status] ?? { cls: "badge-ghost", icon: Clock3, label: job.status };
  const Icon = cfg.icon;
  const isRunning = job.status === "RUNNING";
  const isDone = job.status === "DONE" || job.status === "FAILED";

  const src = job.source;
  const name = src?.name ?? "Fonte desconhecida";
  const destination = src
    ? `${src.dataset.project.name} → ${src.dataset.name}`
    : "—";

  const workerSlot = job.lockedBy
    ? job.lockedBy.replace(/^.+-(\d+)$/, "slot $1")
    : null;

  return (
    <div className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <DatabaseZap size={14} className="shrink-0 text-base-content/40" />
          <p className="truncate font-medium">{name}</p>
          <span className={`badge badge-sm shrink-0 gap-1 ${cfg.cls}`}>
            <Icon size={11} className={isRunning ? "animate-spin" : ""} />
            {cfg.label}
          </span>
        </div>

        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-base-content/55">
          <span>{destination}</span>
          <span>·</span>
          <span>atualização de fonte</span>
          <span>·</span>
          <span>{fmtRelative(job.createdAt)}</span>
          {workerSlot && isRunning && (
            <>
              <span>·</span>
              <span className="text-accent" title={job.lockedBy ?? ""}>⚙ {workerSlot}</span>
            </>
          )}
          {job.attempts > 0 && (
            <>
              <span>·</span>
              <span title="Tentativas">tentativa {job.attempts}/{job.maxAttempts}</span>
            </>
          )}
          {isDone && (
            <>
              <span>·</span>
              <span title="Duração total">⏱ {fmtDuration(job.updatedAt.getTime() - job.createdAt.getTime())}</span>
            </>
          )}
        </div>

        {job.status === "FAILED" && job.lastError && (
          <p className="mt-2 rounded-lg bg-error/10 px-3 py-2 text-xs text-error">
            {job.lastError}
          </p>
        )}
      </div>
    </div>
  );
}
