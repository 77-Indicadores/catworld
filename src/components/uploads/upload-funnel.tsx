import { Clock3, Loader2, CheckCircle2, CircleX } from "lucide-react";

const WAITING   = new Set(["PENDING_UPLOAD", "QUEUED_PREVIEW", "AWAITING_CONFIRMATION"]);
const ACTIVE    = new Set(["PREVIEWING", "QUEUED_IMPORT", "IMPORTING", "RETRYING"]);

interface Props {
  counts: { waiting: number; active: number; completed: number; failed: number };
}

interface StageProps {
  icon: React.ReactNode;
  label: string;
  count: number;
  color: string;
  width: number;
  isLast?: boolean;
}

function Stage({ icon, label, count, color, width, isLast }: StageProps) {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center gap-2">
      <div
        className={`flex w-full items-center justify-between rounded-lg px-4 py-3 ${color}`}
        style={{ minWidth: `${width}%` }}
      >
        <div className="flex items-center gap-2">
          {icon}
          <span className="text-sm font-medium">{label}</span>
        </div>
        <span className="text-xl font-bold">{count.toLocaleString("pt-BR")}</span>
      </div>
      {!isLast && (
        <div className="hidden text-base-content/30 sm:block">▶</div>
      )}
    </div>
  );
}

export function UploadFunnel({ counts }: Props) {
  const total = counts.waiting + counts.active + counts.completed + counts.failed;
  if (total === 0) return null;

  const pct = (n: number) => Math.max(20, Math.round((n / total) * 100));

  return (
    <div className="rounded-box border border-base-300 bg-base-100 p-5 shadow-sm">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-base-content/50">Funil de processamento</h2>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <Stage
          icon={<Clock3 size={16} />}
          label="Aguardando"
          count={counts.waiting}
          color="bg-base-200 text-base-content"
          width={pct(counts.waiting)}
        />
        <div className="hidden text-base-content/30 sm:block">▶</div>
        <Stage
          icon={<Loader2 size={16} className="animate-spin" />}
          label="Em andamento"
          count={counts.active}
          color="bg-info/15 text-info"
          width={pct(counts.active)}
        />
        <div className="hidden text-base-content/30 sm:block">▶</div>
        <Stage
          icon={<CheckCircle2 size={16} />}
          label="Concluído"
          count={counts.completed}
          color="bg-success/15 text-success"
          width={pct(counts.completed)}
          isLast={counts.failed === 0}
        />
        {counts.failed > 0 && (
          <>
            <div className="hidden text-base-content/30 sm:block">▶</div>
            <Stage
              icon={<CircleX size={16} />}
              label="Falhou"
              count={counts.failed}
              color="bg-error/15 text-error"
              width={pct(counts.failed)}
              isLast
            />
          </>
        )}
      </div>
    </div>
  );
}

export function countFunnelGroups(statuses: string[]): Props["counts"] {
  let waiting = 0, active = 0, completed = 0, failed = 0;
  for (const s of statuses) {
    if (WAITING.has(s)) waiting++;
    else if (ACTIVE.has(s)) active++;
    else if (s === "COMPLETED") completed++;
    else if (s === "FAILED") failed++;
  }
  return { waiting, active, completed, failed };
}
