"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, CircleX, Eye, Loader2, RefreshCw, Upload as UploadIcon, X, Zap } from "lucide-react";
import { fmtBytes, fmtRelative } from "@/lib/fmt";

export type QueueItem = {
  id: string;
  jobId: string;
  status: "RUNNING" | "QUEUED" | "FAILED";
  weight: number;
  title: string;
  subtitle: string | null;
  meta: string | null;
  progress: number | null;
  lockedBy: string | null;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  cancelPath: string | null;
  retryPath: string | null;
};

type LaneType = "preview" | "import" | "sync";

const LANE_CONFIG: Record<LaneType, { label: string; icon: React.ElementType; accent: string }> = {
  preview: { label: "Preview",  icon: Eye,        accent: "text-info" },
  import:  { label: "Import",   icon: UploadIcon,  accent: "text-accent" },
  sync:    { label: "Sync",     icon: Zap,         accent: "text-secondary" },
};

function workerSlot(lockedBy: string | null) {
  if (!lockedBy) return null;
  const m = lockedBy.match(/-(\d+)(?:@|$)/);
  return m ? `slot ${m[1]}` : null;
}

function JobRow({ item, position }: { item: QueueItem; position?: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"cancel" | "retry" | null>(null);

  const isRunning = item.status === "RUNNING";
  const isFailed  = item.status === "FAILED";
  const isQueued  = item.status === "QUEUED";
  const isHeavy   = item.weight >= 2;

  async function cancel() {
    if (!item.cancelPath) return;
    setBusy("cancel");
    await fetch(item.cancelPath, { method: "POST" });
    router.refresh();
    setBusy(null);
  }

  async function retry() {
    if (!item.retryPath) return;
    setBusy("retry");
    await fetch(item.retryPath, { method: "POST" });
    router.refresh();
    setBusy(null);
  }

  return (
    <div className={`px-4 py-3 ${isRunning ? "bg-info/5" : isFailed ? "bg-error/5" : ""}`}>
      <div className="flex items-start gap-2">
        {/* Position / status indicator */}
        <div className="mt-0.5 w-6 shrink-0 text-center">
          {isRunning && <Loader2 size={14} className="animate-spin text-info" />}
          {isFailed  && <CircleX size={14} className="text-error" />}
          {isQueued  && <span className="text-[11px] font-mono text-base-content/35">{position}°</span>}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="truncate text-sm font-medium">{item.title}</span>
            {isHeavy && isQueued && (
              <span className="badge badge-xs badge-warning shrink-0">pesado</span>
            )}
          </div>

          <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0 text-[11px] text-base-content/45">
            {item.subtitle && <span className="truncate">{item.subtitle}</span>}
            {item.meta && <><span>·</span><span>{item.meta}</span></>}
            <span>·</span>
            <span>{fmtRelative(item.createdAt)}</span>
            {isRunning && workerSlot(item.lockedBy) && (
              <><span>·</span><span className="text-accent">⚙ {workerSlot(item.lockedBy)}</span></>
            )}
            {item.attempts > 1 && (
              <><span>·</span><span>{item.attempts}/{item.maxAttempts} tentativas</span></>
            )}
          </div>

          {isRunning && item.progress !== null && item.progress > 0 && (
            <div className="mt-1.5 flex items-center gap-2">
              <progress className="progress progress-info h-1 w-28" value={item.progress} max={100} />
              <span className="text-[11px] text-base-content/40">{item.progress}%</span>
            </div>
          )}

          {isFailed && item.lastError && (
            <p className="mt-1 rounded bg-error/10 px-2 py-1 text-[11px] text-error line-clamp-2">
              {item.lastError}
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="shrink-0">
          {(isQueued || isRunning) && item.cancelPath && (
            <button
              onClick={cancel}
              disabled={!!busy}
              className="btn btn-ghost btn-xs text-base-content/30 hover:text-error"
              title="Cancelar"
            >
              {busy === "cancel" ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
            </button>
          )}
          {isFailed && item.retryPath && (
            <button
              onClick={retry}
              disabled={!!busy}
              className="btn btn-ghost btn-xs text-base-content/30 hover:text-primary"
              title="Tentar novamente"
            >
              {busy === "retry" ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function QueueLane({
  type,
  items,
  completedCount,
}: {
  type: LaneType;
  items: QueueItem[];
  completedCount: number;
}) {
  const cfg = LANE_CONFIG[type];
  const Icon = cfg.icon;

  const running = items.filter(i => i.status === "RUNNING");
  const queued  = items.filter(i => i.status === "QUEUED");
  const failed  = items.filter(i => i.status === "FAILED");
  const total   = items.length;

  return (
    <div className="rounded-box border border-base-300 bg-base-100 flex flex-col">
      {/* Lane header */}
      <div className="flex items-center justify-between border-b border-base-300 px-4 py-3">
        <div className="flex items-center gap-2">
          <Icon size={14} className={cfg.accent} />
          <span className="text-sm font-semibold">{cfg.label}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {running.length > 0 && (
            <span className="badge badge-info badge-sm gap-1">
              <Loader2 size={9} className="animate-spin" />{running.length}
            </span>
          )}
          {queued.length > 0 && (
            <span className="badge badge-ghost badge-sm">{queued.length} na fila</span>
          )}
          {failed.length > 0 && (
            <span className="badge badge-error badge-sm">{failed.length}</span>
          )}
          {total === 0 && (
            <span className="text-xs text-base-content/25">vazia</span>
          )}
        </div>
      </div>

      {/* Job rows */}
      <div className="flex-1 divide-y divide-base-300">
        {running.map(item => <JobRow key={item.jobId} item={item} />)}
        {queued.map((item, i) => <JobRow key={item.jobId} item={item} position={i + 1} />)}
        {failed.map(item => <JobRow key={item.jobId} item={item} />)}
        {total === 0 && (
          <div className="flex items-center justify-center py-10 text-xs text-base-content/25">
            Sem jobs ativos
          </div>
        )}
      </div>

      {/* Completed footer */}
      {completedCount > 0 && (
        <div className="border-t border-base-300 px-4 py-2">
          <a
            href={`/uploads/history?type=${type}`}
            className="flex items-center gap-1.5 text-[11px] text-base-content/35 hover:text-base-content/60"
          >
            <Archive size={11} />
            {completedCount.toLocaleString("pt-BR")} concluídos
          </a>
        </div>
      )}
    </div>
  );
}
