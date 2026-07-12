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
import type { Upload, Dataset, Project, Job } from "@prisma/client";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const CANCELLABLE = ["PENDING_UPLOAD", "QUEUED_PREVIEW", "AWAITING_CONFIRMATION", "QUEUED_IMPORT", "RETRYING"];

const GROUP_STATUSES: Record<string, string[]> = {
  pending:   ["PENDING_UPLOAD", "QUEUED_PREVIEW", "AWAITING_CONFIRMATION"],
  active:    ["PREVIEWING", "QUEUED_IMPORT", "IMPORTING", "RETRYING"],
  completed: ["COMPLETED"],
  failed:    ["FAILED"],
};

// SOURCE_REFRESH job status → funnel group key
const JOB_GROUP: Record<string, "pending" | "active" | "completed" | "failed"> = {
  QUEUED:    "pending",
  RUNNING:   "active",
  COMPLETED: "completed",
  FAILED:    "failed",
};

// Reverse map: group key → job statuses
const GROUP_TO_JOB_STATUSES: Record<string, string[]> = {};
for (const [jobStatus, group] of Object.entries(JOB_GROUP)) {
  (GROUP_TO_JOB_STATUSES[group] ??= []).push(jobStatus);
}

// Maps job status to an upload status string that countFunnelGroups recognises
const JOB_STATUS_TO_UPLOAD: Record<string, string> = {
  QUEUED:    "PENDING_UPLOAD",
  RUNNING:   "IMPORTING",
  COMPLETED: "COMPLETED",
  FAILED:    "FAILED",
};

function parseComma(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

function extractSourceId(payloadJson: string | null): string | undefined {
  try { return (JSON.parse(payloadJson ?? "{}") as { datasetSourceId?: string }).datasetSourceId; } catch { return undefined; }
}

type RawJob = Pick<Job, "id" | "status" | "lockedBy" | "lastError" | "attempts" | "maxAttempts" | "createdAt" | "updatedAt" | "payloadJson">;
type UploadWithDataset = Upload & { dataset: (Dataset & { project: Project }) | null; jobs: { lockedBy: string | null; status: string; weight: number; attempts: number; maxAttempts: number }[] };
type DataSource = { id: string; name: string; lastRowCount: bigint | null; lastRefreshedAt: Date | null; nextRefreshAt: Date | null; dataset: { id: string; name: string; slug: string; project: { id: string; name: string; slug: string } } };

function buildSourceRefreshJobs(jobs: RawJob[], sourceMap: Map<string, DataSource>): SourceRefreshWithSource[] {
  return jobs.map((j) => {
    const raw = sourceMap.get(extractSourceId(j.payloadJson) ?? "") ?? null;
    const source = raw ? {
      ...raw,
      lastRowCount: raw.lastRowCount != null ? String(raw.lastRowCount) : null,
      lastRefreshedAt: raw.lastRefreshedAt?.toISOString() ?? null,
      nextRefreshAt: raw.nextRefreshAt?.toISOString() ?? null,
    } : null;
    return { ...j, source };
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

  const dbStatuses    = selectedStatuses.flatMap((g) => GROUP_STATUSES[g] ?? []);
  const dbJobStatuses = selectedStatuses.flatMap((g) => GROUP_TO_JOB_STATUSES[g] ?? []);

  const uploadWhere = {
    ...(dbStatuses.length        ? { status:  { in: dbStatuses } } : {}),
    ...(selectedProjectIds.length ? { dataset: { projectId: { in: selectedProjectIds } } } : {}),
  };

  const showUploads = selectedType === "all" || selectedType === "uploads";
  const showSources = selectedType === "all" || selectedType === "sources";

  // Round-trip 1: all independent queries run in parallel
  const [sourceJobs, uploads, uploadTotal, projects, queued, funnelRaw, allStatusCounts] = await Promise.all([
    showSources
      ? prisma.job.findMany({
          where: { type: "SOURCE_REFRESH", ...(dbJobStatuses.length ? { status: { in: dbJobStatuses } } : {}) },
          orderBy: { createdAt: "desc" },
          take: 200,
          select: { id: true, status: true, lockedBy: true, lastError: true, attempts: true, maxAttempts: true, createdAt: true, updatedAt: true, payloadJson: true },
        }) as Promise<RawJob[]>
      : Promise.resolve([] as RawJob[]),
    showUploads
      ? prisma.upload.findMany({
          where: uploadWhere,
          orderBy: { createdAt: "desc" },
          take: PAGE_SIZE,
          skip,
          include: { dataset: { include: { project: true } }, jobs: { orderBy: { createdAt: "desc" }, take: 1, select: { lockedBy: true, status: true, weight: true, attempts: true, maxAttempts: true } } },
        }) as Promise<UploadWithDataset[]>
      : Promise.resolve([] as UploadWithDataset[]),
    showUploads ? prisma.upload.count({ where: uploadWhere }) : Promise.resolve(0),
    prisma.project.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.upload.count({ where: { status: { in: CANCELLABLE } } }),
    showUploads
      ? prisma.upload.groupBy({ by: ["status"], where: uploadWhere, _count: true })
      : Promise.resolve([] as { status: string; _count: number }[]),
    prisma.upload.groupBy({ by: ["status"], _count: true }),
  ]);

  // Round-trip 2: DatasetSources — depends on sourceJobs result from round-trip 1
  const sourceIds = [...new Set(sourceJobs.map((j) => extractSourceId(j.payloadJson)).filter((id): id is string => !!id))];
  const dataSources = sourceIds.length
    ? await prisma.datasetSource.findMany({
        where: {
          id: { in: sourceIds },
          ...(selectedProjectIds.length ? { dataset: { projectId: { in: selectedProjectIds } } } : {}),
        },
        select: { id: true, name: true, lastRowCount: true, lastRefreshedAt: true, nextRefreshAt: true, dataset: { select: { id: true, name: true, slug: true, project: { select: { id: true, name: true, slug: true } } } } },
      })
    : [] as DataSource[];

  const sourceMap = new Map(dataSources.map((s) => [s.id, s]));
  const parsedSourceJobs = buildSourceRefreshJobs(sourceJobs, sourceMap);

  // Project filter applied in JS (Job table has no direct projectId FK)
  const filteredSourceJobs = selectedProjectIds.length
    ? parsedSourceJobs.filter((j) => j.source && selectedProjectIds.includes(j.source.dataset.project.id))
    : parsedSourceJobs;

  // Funnel
  const funnelStatuses = [
    ...funnelRaw.flatMap((r) => Array(r._count).fill(r.status) as string[]),
    ...(showSources ? filteredSourceJobs.map((j) => JOB_STATUS_TO_UPLOAD[j.status] ?? j.status) : []),
  ];
  const funnelCounts = countFunnelGroups(funnelStatuses);

  // Badge counts: unfiltered upload totals + filtered source job counts
  const statusCountMap = Object.fromEntries(allStatusCounts.map((r) => [r.status, r._count]));
  const srcCount = { pending: 0, active: 0, completed: 0, failed: 0 };
  if (showSources) {
    for (const j of filteredSourceJobs) {
      const g = JOB_GROUP[j.status];
      if (g) srcCount[g]++;
    }
  }
  const groupCounts = {
    pending:   (GROUP_STATUSES.pending!).reduce((n, s) => n + (statusCountMap[s] ?? 0), 0) + srcCount.pending,
    active:    (GROUP_STATUSES.active!).reduce((n, s) => n + (statusCountMap[s] ?? 0), 0)  + srcCount.active,
    completed: (statusCountMap["COMPLETED"] ?? 0) + srcCount.completed,
    failed:    (statusCountMap["FAILED"] ?? 0)    + srcCount.failed,
  };

  // Use filteredSourceJobs.length for total (honours project filter and the 200-cap)
  const total = uploadTotal + (showSources ? filteredSourceJobs.length : 0);
  const totalPages = showUploads ? Math.ceil(uploadTotal / PAGE_SIZE) : 1;

  // Combined list:
  //   "all"     view → source jobs injected on page 1 only (interleaved with uploads)
  //   "sources" view → source jobs shown on every "page" (they're not upload-paginated)
  type ListItem = { kind: "upload" | "source"; key: string; createdAt: Date };

  const uploadItems: ListItem[] = uploads.map((u) => ({ kind: "upload", key: u.id, createdAt: u.createdAt }));
  const injectSources = showSources && (!showUploads || page === 1);
  const sourceItems: ListItem[] = injectSources
    ? filteredSourceJobs.map((j) => ({ kind: "source", key: j.id, createdAt: j.createdAt }))
    : [];

  const allItems = [...uploadItems, ...sourceItems].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const uploadMap  = new Map(uploads.map((u) => [u.id, u]));
  const sourceJobMap = new Map(filteredSourceJobs.map((j) => [j.id, j]));
  const allStatuses  = [...uploads.map((u) => u.status), ...filteredSourceJobs.map((j) => j.status)];

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
                if (params.status)    qs.set("status",    params.status);
                if (params.projectId) qs.set("projectId", params.projectId);
                if (t !== "all")      qs.set("type",      t);
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
