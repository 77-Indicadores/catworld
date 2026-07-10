import { Suspense } from "react";
import { FileX2 } from "lucide-react";
import { prisma } from "@/server/db";
import { PageHeader, Panel, EmptyState } from "@/components/ui/primitives";
import { CancelQueueButton } from "@/components/dashboard/cancel-queue";
import { UploadFilters } from "@/components/uploads/upload-filters";
import { UploadCard } from "@/components/uploads/upload-card";
import { UploadPagination } from "@/components/uploads/upload-pagination";
import { UploadPoller } from "@/components/uploads/upload-poller";
import { UploadFunnel, countFunnelGroups } from "@/components/uploads/upload-funnel";
import { SourceRefreshCard, type SourceRefreshWithSource } from "@/components/uploads/source-refresh-card";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const CANCELLABLE = ["PENDING_UPLOAD", "QUEUED_PREVIEW", "AWAITING_CONFIRMATION", "QUEUED_IMPORT", "RETRYING"];

const GROUP_STATUSES: Record<string, string[]> = {
  pending:   ["PENDING_UPLOAD", "QUEUED_PREVIEW", "AWAITING_CONFIRMATION"],
  active:    ["PREVIEWING", "QUEUED_IMPORT", "IMPORTING", "RETRYING"],
  completed: ["COMPLETED"],
  failed:    ["FAILED"],
};

// SOURCE_REFRESH job status → funnel group
const JOB_GROUP: Record<string, string> = {
  QUEUED:  "pending",
  RUNNING: "active",
  DONE:    "completed",
  FAILED:  "failed",
};

function parseComma(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

function parseSourceRefreshJobs(
  jobs: { id: string; status: string; lockedBy: string | null; lastError: string | null; attempts: number; maxAttempts: number; createdAt: Date; updatedAt: Date; payloadJson: string | null }[],
  sourceMap: Map<string, { id: string; name: string; dataset: { id: string; name: string; project: { id: string; name: string } } }>,
): SourceRefreshWithSource[] {
  return jobs.map((j) => {
    let sourceId: string | undefined;
    try { sourceId = (JSON.parse(j.payloadJson ?? "{}") as { datasetSourceId?: string }).datasetSourceId; } catch { /* */ }
    return { ...j, source: sourceId ? (sourceMap.get(sourceId) ?? null) : null };
  });
}

export default async function UploadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;

  const selectedStatuses   = parseComma(params.status);
  const selectedProjectIds = parseComma(params.projectId);
  const selectedType       = params.type ?? "all"; // "all" | "uploads" | "sources"
  const page  = Math.max(1, parseInt(params.page ?? "1", 10));
  const skip  = (page - 1) * PAGE_SIZE;

  // Expand selected status groups into DB status values for uploads
  const dbStatuses = selectedStatuses.flatMap((g) => GROUP_STATUSES[g] ?? []);
  // Map selected group keys to job statuses for SOURCE_REFRESH jobs
  const dbJobStatuses = selectedStatuses.flatMap((g) =>
    Object.entries(JOB_GROUP).filter(([, grp]) => grp === g).map(([s]) => s),
  );

  const uploadWhere = {
    ...(dbStatuses.length       ? { status:  { in: dbStatuses } } : {}),
    ...(selectedProjectIds.length ? { dataset: { projectId: { in: selectedProjectIds } } } : {}),
  };

  const showUploads = selectedType === "all" || selectedType === "uploads";
  const showSources = selectedType === "all" || selectedType === "sources";

  type RawJob = { id: string; status: string; lockedBy: string | null; lastError: string | null; attempts: number; maxAttempts: number; createdAt: Date; updatedAt: Date; payloadJson: string | null };
  // Fetch source refresh jobs (all, not paginated — they're few)
  const [sourceJobs, sourceJobTotal]: [RawJob[], number] = showSources
    ? await Promise.all([
        prisma.job.findMany({
          where: {
            type: "SOURCE_REFRESH",
            ...(dbJobStatuses.length ? { status: { in: dbJobStatuses } } : {}),
          },
          orderBy: { createdAt: "desc" },
          take: 200,
          select: { id: true, status: true, lockedBy: true, lastError: true, attempts: true, maxAttempts: true, createdAt: true, updatedAt: true, payloadJson: true },
        }),
        prisma.job.count({ where: { type: "SOURCE_REFRESH", ...(dbJobStatuses.length ? { status: { in: dbJobStatuses } } : {}) } }),
      ])
    : [[], 0];

  // Resolve DatasetSources for source refresh jobs
  const sourceIds = [...new Set(
    sourceJobs
      .map((j) => { try { return (JSON.parse(j.payloadJson ?? "{}") as { datasetSourceId?: string }).datasetSourceId; } catch { return undefined; } })
      .filter((id): id is string => !!id),
  )];

  const [uploads, uploadTotal, projects, queued, funnelRaw, allStatusCounts, dataSources] = await Promise.all([
    showUploads
      ? prisma.upload.findMany({
          where: uploadWhere,
          orderBy: { createdAt: "desc" },
          take: PAGE_SIZE,
          skip,
          include: { dataset: { include: { project: true } }, jobs: { orderBy: { createdAt: "desc" }, take: 1, select: { lockedBy: true, status: true, weight: true, attempts: true, maxAttempts: true } } },
        })
      : Promise.resolve([]),
    showUploads ? prisma.upload.count({ where: uploadWhere }) : Promise.resolve(0),
    prisma.project.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.upload.count({ where: { status: { in: CANCELLABLE } } }),
    showUploads
      ? prisma.upload.groupBy({ by: ["status"], where: uploadWhere, _count: true })
      : Promise.resolve([]),
    prisma.upload.groupBy({ by: ["status"], _count: true }),
    sourceIds.length
      ? prisma.datasetSource.findMany({
          where: {
            id: { in: sourceIds },
            ...(selectedProjectIds.length ? { dataset: { projectId: { in: selectedProjectIds } } } : {}),
          },
          select: { id: true, name: true, dataset: { select: { id: true, name: true, project: { select: { id: true, name: true } } } } },
        })
      : Promise.resolve([]),
  ]);

  const sourceMap = new Map(dataSources.map((s) => [s.id, s]));
  const parsedSourceJobs = parseSourceRefreshJobs(sourceJobs, sourceMap);

  // Filter source jobs by projectId if needed (when project filter is active)
  const filteredSourceJobs = selectedProjectIds.length
    ? parsedSourceJobs.filter((j) => j.source && selectedProjectIds.includes(j.source.dataset.project.id))
    : parsedSourceJobs;

  // Funnel counts: combine upload statuses + source job statuses
  const funnelStatuses = [
    ...funnelRaw.flatMap((r) => Array(r._count).fill(r.status) as string[]),
    ...filteredSourceJobs.map((j) => {
      const g = JOB_GROUP[j.status];
      // Map group back to a status string recognized by countFunnelGroups
      if (g === "pending")   return "PENDING_UPLOAD";
      if (g === "active")    return "IMPORTING";
      if (g === "completed") return "COMPLETED";
      if (g === "failed")    return "FAILED";
      return j.status;
    }),
  ];
  const funnelCounts = countFunnelGroups(funnelStatuses);

  // Count per group key from unfiltered upload totals
  const statusCountMap = Object.fromEntries(allStatusCounts.map((r) => [r.status, r._count]));
  const groupCounts = {
    pending:   (GROUP_STATUSES.pending!).reduce((n, s) => n + (statusCountMap[s] ?? 0), 0),
    active:    (GROUP_STATUSES.active!).reduce((n, s) => n + (statusCountMap[s] ?? 0), 0),
    completed: statusCountMap["COMPLETED"] ?? 0,
    failed:    statusCountMap["FAILED"] ?? 0,
  };

  const total = uploadTotal + (showSources ? sourceJobTotal : 0);
  const totalPages = showUploads ? Math.ceil(uploadTotal / PAGE_SIZE) : 1;

  // Build combined list for current page: source jobs (page 1 only) + uploads
  type ListItem =
    | { kind: "upload"; key: string; createdAt: Date }
    | { kind: "source"; key: string; createdAt: Date };

  const uploadItems: ListItem[] = uploads.map((u) => ({ kind: "upload", key: u.id, createdAt: u.createdAt }));
  const sourceItems: ListItem[] = page === 1
    ? filteredSourceJobs.map((j) => ({ kind: "source", key: j.id, createdAt: j.createdAt }))
    : [];

  const allItems = [...uploadItems, ...sourceItems].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const uploadMap = new Map(uploads.map((u) => [u.id, u]));
  const sourceJobMap = new Map(filteredSourceJobs.map((j) => [j.id, j]));

  const allStatuses = [
    ...uploads.map((u) => u.status),
    ...filteredSourceJobs.map((j) => j.status),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Gestão de dados"
        title="Processamento"
        description="Acompanhe e gerencie todos os jobs da plataforma."
        actions={<CancelQueueButton queued={queued} />}
      />

      <UploadPoller statuses={allStatuses} />
      <UploadFunnel counts={funnelCounts} />
      <Panel>
        <div className="flex flex-col gap-4 border-b border-base-300 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            {/* Job type toggle */}
            <div className="join mr-1">
              {(["all", "uploads", "sources"] as const).map((t) => {
                const labels = { all: "Todos", uploads: "Uploads", sources: "Fontes" };
                const qs = new URLSearchParams();
                if (params.status) qs.set("status", params.status);
                if (params.projectId) qs.set("projectId", params.projectId);
                if (t !== "all") qs.set("type", t);
                const href = `?${qs.toString()}`;
                return (
                  <a key={t} href={href} className={`join-item btn btn-xs ${selectedType === t ? "btn-neutral" : "btn-ghost border border-base-300"}`}>
                    {labels[t]}
                  </a>
                );
              })}
            </div>
            <Suspense fallback={<div className="flex gap-2"><div className="skeleton h-8 w-32 rounded-lg" /><div className="skeleton h-8 w-36 rounded-lg" /></div>}>
              <UploadFilters
                projects={projects}
                selectedStatuses={selectedStatuses}
                selectedProjectIds={selectedProjectIds}
                groupCounts={groupCounts}
              />
            </Suspense>
          </div>
          <p className="shrink-0 text-xs text-base-content/50">
            {total} job{total !== 1 ? "s" : ""}
          </p>
        </div>

        {allItems.length === 0 ? (
          <EmptyState
            icon={<FileX2 size={32} />}
            title="Nenhum job encontrado"
            description="Tente outros filtros ou faça seu primeiro upload pelo SDK."
          />
        ) : (
          <div className="divide-y divide-base-300">
            {allItems.map((item) =>
              item.kind === "upload"
                ? <UploadCard key={item.key} upload={uploadMap.get(item.key)!} />
                : <SourceRefreshCard key={item.key} job={sourceJobMap.get(item.key)!} />,
            )}
          </div>
        )}

        {totalPages > 1 && (
          <div className="border-t border-base-300 px-5 py-4">
            <Suspense>
              <UploadPagination page={page} totalPages={totalPages} />
            </Suspense>
          </div>
        )}
      </Panel>
    </div>
  );
}
