import Link from "next/link";
import { ArrowLeft, Inbox } from "lucide-react";
import { prisma } from "@/server/db";
import { PageHeader, Panel, EmptyState } from "@/components/ui/primitives";
import { UploadCard } from "@/components/uploads/upload-card";
import { SourceRefreshCard, type SourceRefreshWithSource } from "@/components/uploads/source-refresh-card";
import { UploadFilters } from "@/components/uploads/upload-filters";
import { UploadFunnel, countFunnelGroups } from "@/components/uploads/upload-funnel";
import { UploadPagination } from "@/components/uploads/upload-pagination";
import { resolveActor } from "@/server/auth/actor";
import { visibleProjectIds } from "@/server/auth/permissions";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

/** Grupos de status que a UploadFilters mostra (pending/active/completed/failed) → status reais. */
const UPLOAD_STATUS_GROUPS: Record<string, string[]> = {
  pending: ["PENDING_UPLOAD", "QUEUED_PREVIEW", "AWAITING_CONFIRMATION", "QUEUED_IMPORT"],
  active: ["PREVIEWING", "IMPORTING", "RETRYING"],
  completed: ["COMPLETED"],
  failed: ["FAILED", "CANCELLED"],
};

const JOB_STATUS_GROUPS: Record<string, string[]> = {
  pending: ["QUEUED"],
  active: ["RUNNING"],
  completed: ["COMPLETED"],
  failed: ["FAILED"],
};

function parseCsv(v: string | string[] | undefined): string[] {
  if (!v) return [];
  const s = Array.isArray(v) ? v[0] : v;
  return s.split(",").filter(Boolean);
}

function statusesForGroups(groups: string[], map: Record<string, string[]>): string[] {
  if (groups.length === 0) return Object.values(map).flat();
  return groups.flatMap((g) => map[g] ?? []);
}

type SearchParams = { type?: string; status?: string; projectId?: string; page?: string };

export default async function UploadHistoryPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const type = sp.type === "sync" ? "sync" : sp.type === "import" ? "import" : "preview";
  const statusGroups = parseCsv(sp.status);
  const projectIds = parseCsv(sp.projectId);
  const page = Math.max(1, Number(sp.page) || 1);

  const actor = await resolveActor();
  const scopeIds = await visibleProjectIds(actor);

  const projects = await prisma.project.findMany({
    where: { active: true, ...(scopeIds ? { id: { in: scopeIds } } : {}) },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  const allowedProjectIds = scopeIds ?? projects.map((p) => p.id);
  const effectiveProjectIds = projectIds.length ? projectIds.filter((id) => allowedProjectIds.includes(id)) : allowedProjectIds;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Gestão de dados"
        title="Histórico de processamento"
        description="Uploads e sincronizações já concluídos, com falha ou cancelados."
        actions={<Link href="/uploads" className="btn btn-ghost btn-sm gap-1.5"><ArrowLeft size={15} />Voltar para a fila</Link>}
      />

      <div className="flex flex-wrap gap-2">
        {(["preview", "import", "sync"] as const).map((t) => (
          <Link
            key={t}
            href={`/uploads/history?type=${t}`}
            className={`btn btn-sm ${type === t ? "btn-primary" : "btn-ghost"}`}
          >
            {t === "preview" ? "Prévias" : t === "import" ? "Importações" : "Sincronizações"}
          </Link>
        ))}
      </div>

      {type === "sync" ? (
        <SyncHistory statusGroups={statusGroups} projectIds={effectiveProjectIds} page={page} />
      ) : (
        <UploadHistory statusGroups={statusGroups} projects={projects} projectIds={projectIds} effectiveProjectIds={effectiveProjectIds} page={page} />
      )}
    </div>
  );
}

async function UploadHistory({
  statusGroups,
  projects,
  projectIds,
  effectiveProjectIds,
  page,
}: {
  statusGroups: string[];
  projects: { id: string; name: string }[];
  projectIds: string[];
  effectiveProjectIds: string[];
  page: number;
}) {
  const scopeWhere = {
    OR: [{ datasetId: null }, { dataset: { projectId: { in: effectiveProjectIds } } }],
  };

  const allInScope = await prisma.upload.findMany({
    where: scopeWhere,
    select: { status: true },
  });
  const groupCounts = {
    pending: allInScope.filter((u) => UPLOAD_STATUS_GROUPS.pending.includes(u.status)).length,
    active: allInScope.filter((u) => UPLOAD_STATUS_GROUPS.active.includes(u.status)).length,
    completed: allInScope.filter((u) => UPLOAD_STATUS_GROUPS.completed.includes(u.status)).length,
    failed: allInScope.filter((u) => UPLOAD_STATUS_GROUPS.failed.includes(u.status)).length,
  };
  const funnelCounts = countFunnelGroups(allInScope.map((u) => u.status));

  const statuses = statusesForGroups(statusGroups, UPLOAD_STATUS_GROUPS);
  const where = { ...scopeWhere, status: { in: statuses } };
  const total = await prisma.upload.count({ where });
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const uploads = await prisma.upload.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
    include: {
      dataset: { include: { project: true } },
      jobs: { select: { lockedBy: true, status: true, weight: true, attempts: true, maxAttempts: true }, take: 1, orderBy: { createdAt: "desc" } },
    },
  });

  const completedIds = uploads.filter((u) => u.status === "COMPLETED").map((u) => u.id);
  const perfEvents = completedIds.length
    ? await prisma.auditEvent.findMany({
        where: { eventType: "UPLOAD_IMPORT_PERF", resourceType: "upload", resourceId: { in: completedIds } },
        select: { resourceId: true, detailJson: true },
      })
    : [];
  const importSummaryMap = new Map(
    perfEvents.map((e) => {
      try {
        return [e.resourceId, JSON.parse(e.detailJson ?? "{}")] as const;
      } catch {
        return [e.resourceId, {}] as const;
      }
    }),
  );

  return (
    <>
      <UploadFunnel counts={funnelCounts} />
      <UploadFilters
        projects={projects}
        selectedStatuses={statusGroups}
        selectedProjectIds={projectIds}
        groupCounts={groupCounts}
      />
      <Panel>
        {uploads.length === 0 ? (
          <EmptyState icon={<Inbox size={26} />} title="Nada por aqui" description="Nenhum upload encontrado com esses filtros." />
        ) : (
          <div className="divide-y divide-base-300">
            {uploads.map((u) => (
              <UploadCard key={u.id} upload={u} importSummary={importSummaryMap.get(u.id)} />
            ))}
          </div>
        )}
      </Panel>
      {totalPages > 1 && (
        <div className="flex justify-center">
          <UploadPagination page={page} totalPages={totalPages} />
        </div>
      )}
    </>
  );
}

async function SyncHistory({
  statusGroups,
  projectIds,
  page,
}: {
  statusGroups: string[];
  projectIds: string[];
  page: number;
}) {
  const statuses = statusesForGroups(statusGroups, JOB_STATUS_GROUPS);
  const jobs = await prisma.job.findMany({
    where: { type: "SOURCE_REFRESH", status: { in: statuses } },
    orderBy: { updatedAt: "desc" },
    select: { id: true, status: true, lockedBy: true, lastError: true, attempts: true, maxAttempts: true, createdAt: true, updatedAt: true, payloadJson: true },
  });

  function extractSourceId(payloadJson: string | null): string | null {
    try {
      return (JSON.parse(payloadJson ?? "{}") as { datasetSourceId?: string }).datasetSourceId ?? null;
    } catch {
      return null;
    }
  }

  const sourceIds = [...new Set(jobs.map((j) => extractSourceId(j.payloadJson)).filter((x): x is string => !!x))];
  const sources = sourceIds.length
    ? await prisma.datasetSource.findMany({
        where: { id: { in: sourceIds }, dataset: { projectId: { in: projectIds } } },
        select: {
          id: true, name: true, lastRowCount: true, lastRefreshedAt: true, nextRefreshAt: true,
          dataset: { select: { id: true, name: true, slug: true, project: { select: { id: true, name: true, slug: true } } } },
        },
      })
    : [];
  const sourceMap = new Map(sources.map((s) => [s.id, s]));

  const visibleJobs = jobs.filter((j) => {
    const srcId = extractSourceId(j.payloadJson);
    return srcId ? sourceMap.has(srcId) : false;
  });

  const total = visibleJobs.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageJobs = visibleJobs.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const items: SourceRefreshWithSource[] = pageJobs.map((j) => {
    const srcId = extractSourceId(j.payloadJson);
    const src = srcId ? sourceMap.get(srcId) ?? null : null;
    return {
      id: j.id,
      status: j.status,
      lockedBy: j.lockedBy,
      lastError: j.lastError,
      attempts: j.attempts,
      maxAttempts: j.maxAttempts,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
      source: src
        ? {
            id: src.id,
            name: src.name,
            lastRowCount: src.lastRowCount != null ? String(src.lastRowCount) : null,
            lastRefreshedAt: src.lastRefreshedAt?.toISOString() ?? null,
            nextRefreshAt: src.nextRefreshAt?.toISOString() ?? null,
            dataset: src.dataset,
          }
        : null,
    };
  });

  return (
    <>
      <Panel>
        {items.length === 0 ? (
          <EmptyState icon={<Inbox size={26} />} title="Nada por aqui" description="Nenhuma sincronização encontrada com esses filtros." />
        ) : (
          <div className="divide-y divide-base-300">
            {items.map((j) => (
              <SourceRefreshCard key={j.id} job={j} />
            ))}
          </div>
        )}
      </Panel>
      {totalPages > 1 && (
        <div className="flex justify-center">
          <UploadPagination page={page} totalPages={totalPages} />
        </div>
      )}
    </>
  );
}
