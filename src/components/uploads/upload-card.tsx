"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, CircleAlert, CircleX, Clock3, Loader2, X } from "lucide-react";
import type { Upload, Dataset, Project } from "@prisma/client";

type UploadWithDataset = Upload & { dataset: (Dataset & { project: Project }) | null };

function fmtBytes(n: bigint | number) {
  const v = Number(n);
  if (!v) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(v) / Math.log(1024)), 4);
  return `${(v / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function fmtRelative(date: Date) {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "agora";
  if (mins < 60) return `há ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `há ${hours}h`;
  return `há ${Math.floor(hours / 24)}d`;
}

function fmtDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const STATUS_CONFIG: Record<string, { cls: string; icon: React.ElementType; label: string }> = {
  COMPLETED:              { cls: "badge-success",  icon: CheckCircle2, label: "Concluído" },
  FAILED:                 { cls: "badge-error",    icon: CircleX,      label: "Falhou" },
  AWAITING_CONFIRMATION:  { cls: "badge-warning",  icon: CircleAlert,  label: "Aguardando confirmação" },
  QUEUED_PREVIEW:         { cls: "badge-info",     icon: Loader2,      label: "Analisando" },
  QUEUED_IMPORT:          { cls: "badge-info",     icon: Loader2,      label: "Importando" },
  RETRYING:               { cls: "badge-warning",  icon: Loader2,      label: "Tentando novamente" },
  PENDING_UPLOAD:         { cls: "badge-ghost",    icon: Clock3,       label: "Aguardando upload" },
};

const MODE_LABELS: Record<string, string> = {
  replace: "substituição",
  append:  "adição",
  upsert:  "upsert",
};

const CANCELLABLE = new Set(["PENDING_UPLOAD","QUEUED_PREVIEW","PREVIEWING","AWAITING_CONFIRMATION","QUEUED_IMPORT","IMPORTING","RETRYING"]);

export function UploadCard({ upload }: { upload: UploadWithDataset }) {
  const router = useRouter();
  const [cancelling, setCancelling] = useState(false);

  const cfg = STATUS_CONFIG[upload.status] ?? { cls: "badge-ghost", icon: Clock3, label: upload.status };
  const Icon = cfg.icon;
  const isInProgress = ["QUEUED_PREVIEW", "QUEUED_IMPORT", "RETRYING"].includes(upload.status);
  const canCancel = CANCELLABLE.has(upload.status);

  const handleCancel = async () => {
    if (!confirm(`Cancelar o upload de "${upload.originalFilename}"?`)) return;
    setCancelling(true);
    try {
      await fetch(`/api/v1/uploads/${upload.id}?action=cancel`, { method: "POST" });
      router.refresh();
    } finally {
      setCancelling(false);
    }
  };

  const ds = upload.dataset;
  const destination = ds
    ? ds.project?.name
      ? `${ds.project.name} → ${ds.name}`
      : ds.name
    : "Destino pendente";

  return (
    <div className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate font-medium">{upload.originalFilename}</p>
          <span className={`badge badge-sm shrink-0 gap-1 ${cfg.cls}`}>
            <Icon size={11} className={isInProgress ? "animate-spin" : ""} />
            {cfg.label}
          </span>
        </div>

        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-base-content/55">
          <span>{destination}</span>
          <span>·</span>
          <span>{MODE_LABELS[upload.mode] ?? upload.mode}</span>
          <span>·</span>
          <span>{fmtBytes(upload.sizeBytes)}</span>
          {upload.insertedCount != null && (
            <>
              <span>·</span>
              <span>{Number(upload.insertedCount).toLocaleString("pt-BR")} linhas</span>
            </>
          )}
          {upload.updatedCount != null && Number(upload.updatedCount) > 0 && (
            <>
              <span>·</span>
              <span>{Number(upload.updatedCount).toLocaleString("pt-BR")} removidas</span>
            </>
          )}
          <span>·</span>
          <span>{fmtRelative(upload.createdAt)}</span>
          {(upload.status === "COMPLETED" || upload.status === "FAILED") && (
            <>
              <span>·</span>
              <span title="Duração total">⏱ {fmtDuration(upload.updatedAt.getTime() - upload.createdAt.getTime())}</span>
            </>
          )}
        </div>

        {upload.status === "FAILED" && upload.errorMessage && (
          <p className="mt-2 rounded-lg bg-error/10 px-3 py-2 text-xs text-error">
            {upload.errorMessage}
          </p>
        )}

        {isInProgress && upload.progress > 0 && (
          <div className="mt-2 flex items-center gap-2">
            <progress className="progress progress-info w-40" value={upload.progress} max={100} />
            <span className="text-xs text-base-content/50">{upload.progress}%</span>
          </div>
        )}
      </div>

      {canCancel && (
        <button
          className="btn btn-ghost btn-xs text-error mt-1 shrink-0"
          onClick={handleCancel}
          disabled={cancelling}
          title="Cancelar upload"
        >
          {cancelling ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />}
          {cancelling ? "Cancelando..." : "Cancelar"}
        </button>
      )}
    </div>
  );
}
