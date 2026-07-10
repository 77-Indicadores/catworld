"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, CircleAlert, CircleX, Clock3, Loader2, X } from "lucide-react";
import type { Upload, Dataset, Project } from "@prisma/client";
import { fmtBytes, fmtRelative, fmtDuration } from "@/lib/fmt";

type JobSummary = { lockedBy: string | null; status: string; weight: number; attempts: number; maxAttempts: number };
type UploadWithDataset = Upload & { dataset: (Dataset & { project: Project }) | null; jobs: JobSummary[] };

const STATUS_CONFIG: Record<string, { cls: string; icon: React.ElementType; label: string }> = {
  COMPLETED:              { cls: "badge-success",  icon: CheckCircle2, label: "Concluído" },
  FAILED:                 { cls: "badge-error",    icon: CircleX,      label: "Falhou" },
  AWAITING_CONFIRMATION:  { cls: "badge-warning",  icon: CircleAlert,  label: "Aguardando confirmação" },
  QUEUED_PREVIEW:         { cls: "badge-info",     icon: Loader2,      label: "Analisando" },
  QUEUED_IMPORT:          { cls: "badge-info",     icon: Loader2,      label: "Importando" },
  IMPORTING:              { cls: "badge-info",     icon: Loader2,      label: "Importando" },
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
  const isInProgress = ["QUEUED_PREVIEW", "QUEUED_IMPORT", "IMPORTING", "RETRYING"].includes(upload.status);
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

  const job = upload.jobs[0] ?? null;
  const workerSlot = job?.lockedBy
    ? job.lockedBy.replace(/^.+-(\d+)$/, "slot $1")
    : null;
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
          {workerSlot && upload.status === "IMPORTING" && (
            <>
              <span>·</span>
              <span className="text-accent" title={job?.lockedBy ?? ""}>⚙ {workerSlot}</span>
            </>
          )}
          {job && ["IMPORTING", "RETRYING", "QUEUED_IMPORT"].includes(upload.status) && job.attempts > 0 && (
            <>
              <span>·</span>
              <span title="Tentativas">tentativa {job.attempts}/{job.maxAttempts}</span>
            </>
          )}
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
