import { prisma } from "@/server/db";
import { PageHeader } from "@/components/ui/primitives";
import { CancelQueueButton } from "@/components/dashboard/cancel-queue";
import { UploadPoller } from "@/components/uploads/upload-poller";
import { QueueLane, type QueueItem } from "@/components/uploads/queue-lane";
import { FailedActions } from "@/components/uploads/failed-actions";
import { fmtBytes } from "@/lib/fmt";
import { formatInt, isEmptyOutcome } from "@/lib/present";
import { resolveActor } from "@/server/auth/actor";
import { visibleProjectIds } from "@/server/auth/permissions";

export const dynamic = "force-dynamic";

const ACTIVE = ["QUEUED", "RUNNING", "FAILED"] as const;
// guardedQueue (actions.ts) marca o job anterior como FAILED com esse lastError sempre que uma nova tentativa é
// enfileirada (retry) — é contabilidade interna, nunca a tentativa "atual": por construção sempre existe um job
// mais novo por trás. Mostrar isso na fila fazia uploads que já progrediram (ou já concluíram) aparecerem como
// erro precisando de atenção.
const NOT_SUPERSEDED = { NOT: { status: "FAILED" as const, lastError: "Superseded by retry" } };

const MODE_LABELS: Record<string, string> = {
  replace: "substituição",
  append:  "adição",
  upsert:  "upsert",
};

function extractSourceId(payloadJson: string | null): string | null {
  try { return (JSON.parse(payloadJson ?? "{}") as { datasetSourceId?: string }).datasetSourceId ?? null; }
  catch { return null; }
}

function fmtRows(n: bigint | null) {
  if (n == null) return null;
  return `${formatInt(n)} linhas`;
}

export default async function UploadsPage() {
  const actor = await resolveActor();
  const ids = await visibleProjectIds(actor);
  const visible = (projectId: string | null | undefined) => ids === null || !projectId || ids.includes(projectId);

  const [previewJobs, importJobs, sourceJobs, completedCounts, cancelableCount] = await Promise.all([
    prisma.job.findMany({
      where: { type: "PREVIEW_UPLOAD", status: { in: [...ACTIVE] }, ...NOT_SUPERSEDED },
      orderBy: [{ weight: "asc" }, { createdAt: "asc" }],
      include: {
        upload: {
          select: {
            id: true, originalFilename: true, sizeBytes: true, mode: true, progress: true,
            dataset: { select: { name: true, project: { select: { id: true, name: true } } } },
          },
        },
      },
    }),
    prisma.job.findMany({
      where: { type: "IMPORT_UPLOAD", status: { in: [...ACTIVE] }, ...NOT_SUPERSEDED },
      orderBy: [{ weight: "asc" }, { createdAt: "asc" }],
      include: {
        upload: {
          select: {
            id: true, originalFilename: true, sizeBytes: true, mode: true, progress: true,
            dataset: { select: { name: true, project: { select: { id: true, name: true } } } },
          },
        },
      },
    }),
    prisma.job.findMany({
      where: { type: "SOURCE_REFRESH", status: { in: [...ACTIVE] } },
      orderBy: [{ weight: "asc" }, { createdAt: "asc" }],
      select: {
        id: true, status: true, lockedBy: true, weight: true,
        attempts: true, maxAttempts: true, lastError: true,
        createdAt: true, updatedAt: true, payloadJson: true,
      },
    }),
    prisma.job.groupBy({
      by: ["type"],
      where: { status: "COMPLETED", type: { in: ["PREVIEW_UPLOAD", "IMPORT_UPLOAD", "SOURCE_REFRESH"] } },
      _count: true,
    }),
    prisma.upload.count({
      where: { status: { in: ["PENDING_UPLOAD", "QUEUED_PREVIEW", "AWAITING_CONFIRMATION", "QUEUED_IMPORT", "RETRYING"] } },
    }),
  ]);

  const visiblePreviewJobs = previewJobs.filter(j => visible(j.upload?.dataset?.project.id));
  const visibleImportJobs = importJobs.filter(j => visible(j.upload?.dataset?.project.id));

  // Enrich sync jobs with source data
  const sourceIds = [...new Set(sourceJobs.map(j => extractSourceId(j.payloadJson)).filter((x): x is string => !!x))];
  const sources = sourceIds.length
    ? await prisma.datasetSource.findMany({
        where: { id: { in: sourceIds } },
        select: { id: true, name: true, lastRowCount: true, dataset: { select: { name: true, project: { select: { id: true, name: true, slug: true } } } } },
      })
    : [];
  const sourceMap = new Map(sources.map(s => [s.id, s]));
  const visibleSourceJobs = sourceJobs.filter(j => {
    const srcId = extractSourceId(j.payloadJson);
    const src = srcId ? sourceMap.get(srcId) : null;
    return visible(src?.dataset.project.id);
  });

  const completedMap = Object.fromEntries(completedCounts.map(r => [r.type, r._count]));

  // Transform upload jobs → QueueItem
  function uploadToItem(job: typeof previewJobs[number]): QueueItem {
    const u = job.upload;
    const dest = u?.dataset
      ? `${u.dataset.project.name} → ${u.dataset.name}`
      : null;
    return {
      id:          u?.id ?? job.id,
      jobId:       job.id,
      status:      job.status as QueueItem["status"],
      weight:      job.weight,
      title:       u?.originalFilename ?? "Upload sem arquivo",
      subtitle:    dest,
      meta:        u ? [fmtBytes(u.sizeBytes), MODE_LABELS[u.mode] ?? u.mode].join(" · ") : null,
      progress:    u?.progress ?? null,
      lockedBy:    job.lockedBy,
      attempts:    job.attempts,
      maxAttempts: job.maxAttempts,
      lastError:   job.lastError,
      createdAt:   job.createdAt,
      updatedAt:   job.updatedAt,
      cancelPath:  u ? `/api/v1/uploads/${u.id}?action=cancel` : null,
      retryPath:   u ? `/api/v1/uploads/${u.id}?action=retry`  : null,
    };
  }

  // Transform sync jobs → QueueItem
  const syncItems: QueueItem[] = visibleSourceJobs.map(job => {
    const srcId = extractSourceId(job.payloadJson);
    const src   = srcId ? sourceMap.get(srcId) ?? null : null;
    const dest  = src ? `${src.dataset.project.name} → ${src.dataset.name}` : null;
    return {
      id:          job.id,
      jobId:       job.id,
      status:      job.status as QueueItem["status"],
      weight:      job.weight,
      title:       src?.name ?? "Fonte desconhecida",
      subtitle:    dest,
      meta:        fmtRows(src?.lastRowCount ?? null),
      progress:    null,
      lockedBy:    job.lockedBy,
      attempts:    job.attempts,
      maxAttempts: job.maxAttempts,
      lastError:   job.lastError,
      createdAt:   job.createdAt,
      updatedAt:   job.updatedAt,
      cancelPath:  src ? `/api/v1/dataset-sources/${src.id}/refresh?action=cancel` : null,
      retryPath:   src ? `/api/v1/dataset-sources/${src.id}/refresh` : null,
    };
  });

  const previewItems = visiblePreviewJobs.map(uploadToItem);
  const importItems  = visibleImportJobs.map(uploadToItem);

  const failedCount = [...previewItems, ...importItems, ...syncItems]
    .filter(i => i.status === "FAILED" && !isEmptyOutcome(i.lastError)).length;

  const allStatuses = [
    ...previewItems.map(i => i.status),
    ...importItems.map(i => i.status),
    ...syncItems.map(i => i.status),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Gestão de dados"
        title="Processamento"
        description="Estado atual das filas de processamento."
        actions={<CancelQueueButton queued={cancelableCount} />}
      />

      <UploadPoller statuses={allStatuses} />

      <FailedActions count={failedCount} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <QueueLane
          type="preview"
          items={previewItems}
          completedCount={completedMap["PREVIEW_UPLOAD"] ?? 0}
        />
        <QueueLane
          type="import"
          items={importItems}
          completedCount={completedMap["IMPORT_UPLOAD"] ?? 0}
        />
        <QueueLane
          type="sync"
          items={syncItems}
          completedCount={completedMap["SOURCE_REFRESH"] ?? 0}
        />
      </div>
    </div>
  );
}
