import Link from "next/link";
import { ChevronRight, Database, FolderKanban, Gauge, Timer } from "lucide-react";
import { prisma } from "@/server/db";
import { sqlPool } from "@/server/azure/sql";
import { PageHeader, Panel, StatCard } from "@/components/ui/primitives";
export const dynamic = "force-dynamic";

type DtuRow = { avg_dtu_pct: number | null; peak_dtu_pct: number | null };
type JobStatsRow = {
  running_count: number;
  queued_count: number;
  completed_today: number;
  failed_today: number;
};
type AvgRow = { avg_sec: number | null };

export default async function DashboardPage() {
  const STALE_THRESHOLD = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const pool = await sqlPool();

  const [projectCount, datasetCount, avgRows, jobStatsRows, dtuResult, projectsData] =
    await Promise.all([
      prisma.project.count({ where: { active: true } }),
      prisma.dataset.count({ where: { active: true } }),
      prisma.$queryRaw<AvgRow[]>`
        SELECT AVG(DATEDIFF(SECOND, created_at, updated_at)) avg_sec
        FROM cw_jobs
        WHERE status = 'COMPLETED' AND type = 'SOURCE_REFRESH'
          AND updated_at >= DATEADD(DAY, -7, GETUTCDATE())
      `,
      prisma.$queryRaw<JobStatsRow[]>`
        SELECT
          SUM(CASE WHEN status = 'RUNNING' THEN 1 ELSE 0 END) running_count,
          SUM(CASE WHEN status = 'QUEUED'  THEN 1 ELSE 0 END) queued_count,
          SUM(CASE WHEN status = 'COMPLETED' AND created_at >= DATEADD(DAY,-1,GETUTCDATE()) THEN 1 ELSE 0 END) completed_today,
          SUM(CASE WHEN status = 'FAILED'    AND created_at >= DATEADD(DAY,-1,GETUTCDATE()) THEN 1 ELSE 0 END) failed_today
        FROM cw_jobs
        WHERE type = 'SOURCE_REFRESH'
          AND (status IN ('RUNNING','QUEUED') OR created_at >= DATEADD(DAY,-1,GETUTCDATE()))
      `,
      pool.request().query<DtuRow>(`
        SELECT
          AVG(CASE
            WHEN avg_cpu_percent >= avg_data_io_percent AND avg_cpu_percent >= avg_log_write_percent THEN avg_cpu_percent
            WHEN avg_data_io_percent >= avg_log_write_percent THEN avg_data_io_percent
            ELSE avg_log_write_percent
          END) AS avg_dtu_pct,
          MAX(CASE
            WHEN avg_cpu_percent >= avg_data_io_percent AND avg_cpu_percent >= avg_log_write_percent THEN avg_cpu_percent
            WHEN avg_data_io_percent >= avg_log_write_percent THEN avg_data_io_percent
            ELSE avg_log_write_percent
          END) AS peak_dtu_pct
        FROM sys.dm_db_resource_stats
        WHERE end_time >= DATEADD(MINUTE, -60, GETUTCDATE())
      `),
      prisma.project.findMany({
        where: { active: true },
        orderBy: { name: "asc" },
        include: {
          datasets: {
            where: { active: true },
            orderBy: { name: "asc" },
            include: { tables: { select: { lastDataAt: true } } },
          },
        },
      }),
    ]);

  const avgSec = avgRows[0]?.avg_sec ?? 0;
  const dtu = dtuResult.recordset[0];
  const jobs = jobStatsRows[0] ?? { running_count: 0, queued_count: 0, completed_today: 0, failed_today: 0 };
  const tableCount = projectsData.reduce((n, p) => n + p.datasets.reduce((m, d) => m + d.tables.length, 0), 0);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={new Intl.DateTimeFormat("pt-BR", { dateStyle: "long" }).format(new Date())}
        title="Visão geral"
        description="Saúde, atividade e volume da sua plataforma de dados."
        actions={<Link href="/projects" className="btn btn-primary btn-sm"><FolderKanban size={16} />Ver projetos</Link>}
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Projetos" value={String(projectCount)} hint="projetos ativos" icon={<FolderKanban size={20} />} />
        <StatCard label="Datasets" value={String(datasetCount)} hint={`${tableCount} tabelas`} icon={<Database size={20} />} />
        <StatCard
          label="DTU médio"
          value={`${Math.round(dtu?.avg_dtu_pct ?? 0)} %`}
          hint={`pico ${Math.round(dtu?.peak_dtu_pct ?? 0)} % · última hora`}
          icon={<Gauge size={20} />}
        />
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

      <div className="grid gap-6">
        <Panel title="Atualização dos projetos">
          <div className="divide-y divide-base-300">
            {projectsData.length === 0 && (
              <p className="p-6 text-sm text-base-content/50">Nenhum projeto ativo.</p>
            )}
            {projectsData.map((project) => {
              const allTables = project.datasets.flatMap((d) => d.tables);
              const staleTables = allTables.filter(
                (t) => !t.lastDataAt || t.lastDataAt < STALE_THRESHOLD,
              );
              const hasStale = staleTables.length > 0;

              return (
                <details key={project.id} className="group">
                  <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-3.5 hover:bg-base-200/60">
                    <div className="flex min-w-0 items-center gap-3">
                      <ChevronRight
                        size={14}
                        className="shrink-0 text-base-content/40 transition-transform group-open:rotate-90"
                      />
                      <span className="truncate text-sm font-medium">{project.name}</span>
                    </div>
                    <div className="ml-3 flex shrink-0 items-center gap-2">
                      {hasStale ? (
                        <span className="badge badge-sm badge-warning gap-1">
                          {staleTables.length} desatualizada{staleTables.length !== 1 ? "s" : ""}
                        </span>
                      ) : allTables.length > 0 ? (
                        <span className="badge badge-sm badge-success gap-1">Em dia</span>
                      ) : (
                        <span className="badge badge-sm badge-ghost">Sem tabelas</span>
                      )}
                      <span className="text-xs text-base-content/40">{allTables.length} tab.</span>
                    </div>
                  </summary>

                  <div className="border-t border-base-300 bg-base-200/40">
                    {project.datasets.length === 0 && (
                      <p className="px-10 py-3 text-xs text-base-content/50">Sem datasets.</p>
                    )}
                    {project.datasets.map((dataset) => {
                      const dsStale = dataset.tables.filter(
                        (t) => !t.lastDataAt || t.lastDataAt < STALE_THRESHOLD,
                      ).length;
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
                            {dsStale > 0 ? (
                              <span className="badge badge-xs badge-warning">{dsStale} desatual.</span>
                            ) : dsTotal > 0 ? (
                              <span className="badge badge-xs badge-success">Em dia</span>
                            ) : null}
                            <span className="text-xs text-base-content/40">{dsTotal} tab.</span>
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
      <span className="text-xs text-base-content/55">{label}</span>
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
