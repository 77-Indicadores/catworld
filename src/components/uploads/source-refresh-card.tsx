"use client";

import { CheckCircle2, CircleDashed, CircleX, Clock3, DatabaseZap, ExternalLink, Loader2 } from "lucide-react";
import { fmtRelative, fmtDuration } from "@/lib/fmt";
import { Time } from "@/components/ui/time";
import { presentCount, isEmptyOutcome } from "@/lib/present";

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
    lastRowCount: string | null;
    lastRefreshedAt: string | null;
    nextRefreshAt: string | null;
    dataset: {
      id: string;
      name: string;
      slug: string;
      project: { id: string; name: string; slug: string };
    };
  } | null;
};

const STATUS_CONFIG: Record<string, { cls: string; icon: React.ElementType; label: string }> = {
  QUEUED:    { cls: "badge-ghost",   icon: Clock3,       label: "Aguardando" },
  RUNNING:   { cls: "badge-info",    icon: Loader2,      label: "Em andamento" },
  COMPLETED: { cls: "badge-success", icon: CheckCircle2, label: "Concluido" },
  FAILED:    { cls: "badge-error",   icon: CircleX,      label: "Falhou" },
};

function fmtRows(n: string | null) {
  if (!n) return null;
  const c = presentCount(n);
  return c ? `${c.exact} linhas` : null;
}

export function SourceRefreshCard({ job }: { job: SourceRefreshWithSource }) {
  const isEmpty = job.status === "FAILED" && isEmptyOutcome(job.lastError);
  const cfg = isEmpty
    ? { cls: "badge-ghost", icon: CircleDashed, label: "Vazio" }
    : STATUS_CONFIG[job.status] ?? { cls: "badge-ghost", icon: Clock3, label: job.status };
  const Icon = cfg.icon;
  const isRunning = job.status === "RUNNING";
  const isDone = job.status === "COMPLETED" || job.status === "FAILED";

  const src = job.source;
  const name = src?.name ?? "Fonte desconhecida";
  const destination = src
    ? `${src.dataset.project.name} → ${src.dataset.name}`
    : "—";
  const datasetHref = src ? `/projects/${src.dataset.project.slug}` : null;
  const rowsLabel = src ? fmtRows(src.lastRowCount) : null;
  const lastRefreshedIso = src?.lastRefreshedAt ?? null;

  const workerSlot = job.lockedBy
    ? job.lockedBy.replace(/^.+-(\d+)$/, "slot $1")
    : null;

  return (
    <div className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <DatabaseZap size={14} className="shrink-0 text-base-content/65" />
          <p className="truncate font-medium">{name}</p>
          <span className={`badge badge-sm shrink-0 gap-1 ${cfg.cls}`}>
            <Icon size={11} className={isRunning ? "animate-spin" : ""} />
            {cfg.label}
          </span>
        </div>

        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-base-content/65">
          <span>{destination}</span>
          <span>·</span>
          <span>atualização de fonte</span>
          {lastRefreshedIso && (
            <>
              <span>·</span>
              <span title="Última atualização bem-sucedida">✓ <Time iso={lastRefreshedIso} /></span>
            </>
          )}
          {rowsLabel && (
            <>
              <span>·</span>
              <span>{rowsLabel}</span>
            </>
          )}
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
          <p className={`mt-2 rounded-lg px-3 py-2 text-xs ${isEmpty ? "bg-base-200 text-base-content/65" : "bg-error/10 text-error"}`}>
            {job.lastError}
          </p>
        )}
      </div>

      {datasetHref && (
        <a
          href={datasetHref}
          className="btn btn-ghost btn-xs mt-1 shrink-0 text-base-content/65"
          title="Abrir dataset"
        >
          <ExternalLink size={13} />
          Abrir
        </a>
      )}
    </div>
  );
}
