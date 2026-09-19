import Link from "next/link";
import { ChevronRight, Database, FolderKanban, Timer } from "lucide-react";
import { prisma } from "@/server/db";
import { PageHeader, Panel, StatCard } from "@/components/ui/primitives";
import { presentLongDate } from "@/lib/present";
import { StatusBadge } from "@/components/ui/primitives";
import { presentTableFreshness, type RefreshInput } from "@/lib/present";
import { freshnessHeadline, summarizeFreshness, type FreshnessItem } from "@/lib/workspace/summary";

/** Campos de frescor de uma fonte/derivada (Prisma) no formato do apresentador. */
function toRefreshInput(x: { mode?: string | null; active?: boolean | null; lastStatus: string | null; lastError: string | null; refreshCron: string | null; nextRefreshAt: Date | null; lastRefreshedAt: Date | null }): RefreshInput {
  return { mode: x.mode ?? "extract", active: x.active ?? true, lastStatus: x.lastStatus, lastError: x.lastError, refreshCron: x.refreshCron, nextRefreshAt: x.nextRefreshAt?.toISOString() ?? null, lastRefreshedAt: x.lastRefreshedAt?.toISOString() ?? null };
}
export const dynamic = "force-dynamic";

type JobStatsRow = {
  running_count: number;
  queued_count: number;
  completed_today: number;
  failed_today: number;
};
type AvgRow = { avg_sec: number | null };

export default async function DashboardPage() {
  const [projectCount, datasetCount, avgRows, jobStatsRows, projectsData] =
    await Promise.all([
      prisma.project.count({ where: { active: true } }),
      prisma.dataset.count({ where: { active: true } }),
      prisma.$queryRaw<AvgRow[]>`
        SELECT AVG(EXTRACT(EPOCH FROM (updated_at - locked_at))::int) avg_sec
        FROM cw_jobs
        WHERE status = 'COMPLETED' AND type = 'SOURCE_REFRESH'
          AND locked_at IS NOT NULL
          AND updated_at >= NOW() - INTERVAL '7 days'
      `,
      prisma.$queryRaw<JobStatsRow[]>`
        SELECT
          SUM(CASE WHEN status = 'RUNNING' THEN 1 ELSE 0 END)::int running_count,
          SUM(CASE WHEN status = 'QUEUED'  THEN 1 ELSE 0 END)::int queued_count,
          SUM(CASE WHEN status = 'COMPLETED' AND created_at >= NOW() - INTERVAL '1 day' THEN 1 ELSE 0 END)::int completed_today,
          SUM(CASE WHEN status = 'FAILED'    AND created_at >= NOW() - INTERVAL '1 day' THEN 1 ELSE 0 END)::int failed_today
        FROM cw_jobs
        WHERE type = 'SOURCE_REFRESH'
          AND (status IN ('RUNNING','QUEUED') OR created_at >= NOW() - INTERVAL '1 day')
      `,
      prisma.project.findMany({
        where: { active: true },
        orderBy: { name: "asc" },
        include: {
          datasets: {
            where: { active: true },
            orderBy: { name: "asc" },
            include: {
              tables: { select: { id: true, name: true, lastDataAt: true, source: { select: { mode: true, active: true, lastStatus: true, lastError: true, refreshCron: true, nextRefreshAt: true, lastRefreshedAt: true } } } },
              derivedTables: { where: { active: true }, select: { targetTableId: true, active: true, lastStatus: true, lastError: true, refreshCron: true, nextRefreshAt: true, lastRefreshedAt: true } },
            },
          },
        },
      }),
    ]);

  const avgSec = avgRows[0]?.avg_sec ?? 0;
  const jobs = jobStatsRows[0] ?? { running_count: 0, queued_count: 0, completed_today: 0, failed_today: 0 };
  const tableCount = projectsData.reduce((n, p) => n + p.datasets.reduce((m, d) => m + d.tables.length, 0), 0);

  // Frescor de verdade (cron, estado da fonte e da derivada), não "24 h sem dado": tabela só de upload não tem agenda.
  const now = new Date();
  const itemsByDataset = new Map<string, FreshnessItem[]>();
  for (const p of projectsData) {
    for (const d of p.datasets) {
      const derivedByTarget = new Map(d.derivedTables.map((dt) => [dt.targetTableId, dt]));
      itemsByDataset.set(d.id, d.tables.map((t) => {
        const dt = derivedByTarget.get(t.id);
        const freshness = presentTableFreshness({
          lastDataAt: t.lastDataAt?.toISOString() ?? null,
          sources: t.source ? [toRefreshInput(t.source)] : [],
          derived: dt ? toRefreshInput({ ...dt, mode: "extract" }) : null,
        }, now);
        return { key: t.id, name: t.name, group: `${p.name} › ${d.name}`, href: `/projects/${p.slug}`, freshness };
      }));
    }
  }
  const allItems = [...itemsByDataset.values()].flat();
  const attention = [...summarizeFreshness(allItems).failing, ...summarizeFreshness(allItems).stale];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={presentLongDate()}
        title="Visão geral"
        description="Saúde, atividade e volume da sua plataforma de dados."
        actions={<Link href="/projects" className="btn btn-primary btn-sm"><FolderKanban size={16} />Ver projetos</Link>}
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard label="Projetos" value={String(projectCount)} hint="projetos ativos" icon={<FolderKanban size={20} />} />
        <StatCard label="Datasets" value={String(datasetCount)} hint={`${tableCount} tabelas`} icon={<Database size={20} />} />
        <StatCard
          label="Tempo de carga"
          value={formatDuration(avgSec)}
          hint="média por job · 7 dias"
          icon={<Timer size={20} />}
        />
      </div>

      <Panel title="Fila de carga" action={<Link href="/uploads" className="text-xs text-primary hover:underline">Ver uploads</Link>}>
        <div className="grid grid-cols-2 divide-x divide-y divide-base-300 sm:grid-cols-4 sm:divide-y-0">
          <JobStat label="Em execução" value={Number(jobs.running_count)} color="text-info" />
          <JobStat label="Na fila" value={Number(jobs.queued_count)} color="text-warning" />
          <JobStat label="Concluídos hoje" value={Number(jobs.completed_today)} color="text-success" />
          <JobStat label="Com falha hoje" value={Number(jobs.failed_today)} color="text-error" />
        </div>
      </Panel>

      {attention.length > 0 && (
        <Panel title="Precisa de atenção">
          <ul className="divide-y divide-base-300">
            {attention.slice(0, 12).map((it) => (
              <li key={it.key} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5 text-sm">
                <div className="min-w-0">
                  <Link href={it.href ?? "/projects"} className="font-medium hover:underline">{it.name}</Link>
                  <span className="ml-2 text-xs text-base-content/70">{it.group}</span>
                  {it.freshness.reason && <p className="truncate font-mono text-[11px] text-base-content/70">{it.freshness.reason}</p>}
                </div>
                <StatusBadge status={it.freshness.tone} label={it.freshness.label} />
              </li>
            ))}
          </ul>
          {attention.length > 12 && <p className="border-t border-base-300 px-5 py-2 text-xs text-base-content/70">e mais {attention.length - 12}…</p>}
        </Panel>
      )}

      <div className="grid gap-6">
        <Panel title="Atualização dos projetos">
          <div className="divide-y divide-base-300">
            {projectsData.length === 0 && (
              <p className="p-6 text-sm text-base-content/65">Nenhum projeto ativo.</p>
            )}
            {projectsData.map((project) => {
              const allTables = project.datasets.flatMap((d) => d.tables);
              const projectSummary = summarizeFreshness(project.datasets.flatMap((d) => itemsByDataset.get(d.id) ?? []));
              const headline = freshnessHeadline(projectSummary);

              return (
                <details key={project.id} className="group">
                  <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-3.5 hover:bg-base-200/60">
                    <div className="flex min-w-0 items-center gap-3">
                      <ChevronRight
                        size={14}
                        className="shrink-0 text-base-content/65 transition-transform group-open:rotate-90"
                      />
                      <span className="truncate text-sm font-medium">{project.name}</span>
                    </div>
                    <div className="ml-3 flex shrink-0 items-center gap-2">
                      <StatusBadge status={headline.tone} label={headline.label} />
                      <span className="text-xs text-base-content/65">{allTables.length} tab.</span>
                    </div>
                  </summary>

                  <div className="border-t border-base-300 bg-base-200/40">
                    {project.datasets.length === 0 && (
                      <p className="px-10 py-3 text-xs text-base-content/65">Sem datasets.</p>
                    )}
                    {project.datasets.map((dataset) => {
                      const dsSummary = summarizeFreshness(itemsByDataset.get(dataset.id) ?? []);
                      const dsHeadline = freshnessHeadline(dsSummary);
                      const dsTotal = dataset.tables.length;
                      return (
                        <div key={dataset.id} className="flex items-center justify-between px-10 py-2.5">
                          <Link
                            href={`/projects/${project.slug}`}
                            className="text-sm text-base-content/80 hover:text-primary hover:underline"
                          >
                            {dataset.name}
                          </Link>
                          <div className="flex items-center gap-2">
                            {dsTotal > 0 && <StatusBadge status={dsHeadline.tone} label={dsHeadline.label} />}
                            <span className="text-xs text-base-content/65">{dsTotal} tab.</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </details>
              );
            })}
          </div>
        </Panel>

      </div>
    </div>
  );
}

function JobStat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex flex-col gap-1 px-6 py-5">
      <span className={`text-2xl font-bold ${color}`}>{value}</span>
      <span className="text-xs text-base-content/65">{label}</span>
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (!seconds) return "—";
  if (seconds < 60) return `${seconds} s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m} min ${s} s` : `${m} min`;
}
