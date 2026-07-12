import Link from "next/link";
import { Database, FolderKanban, HardDrive, UsersRound } from "lucide-react";
import { prisma } from "@/server/db";
import { PageHeader, Panel, StatCard, StatusBadge } from "@/components/ui/primitives";
import { CancelQueueButton } from "@/components/dashboard/cancel-queue";
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const CANCELLABLE = ["PENDING_UPLOAD", "QUEUED_PREVIEW", "AWAITING_CONFIRMATION", "QUEUED_IMPORT", "RETRYING"];
  const [projects, datasets, tables, users, uploads, audits, queued] = await Promise.all([
    prisma.project.count({ where: { active: true } }),
    prisma.dataset.count({ where: { active: true } }),
    prisma.datasetTable.findMany(),
    prisma.user.count({ where: { active: true } }),
    prisma.upload.findMany({ take: 5, orderBy: { createdAt: "desc" }, include: { dataset: true } }),
    prisma.auditEvent.findMany({ take: 6, orderBy: { createdAt: "desc" }, include: { user: true } }),
    prisma.upload.count({ where: { status: { in: CANCELLABLE } } }),
  ]);
  const bytes = tables.reduce((n, t) => n + t.sizeBytes, 0n);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={new Intl.DateTimeFormat("pt-BR", { dateStyle: "long" }).format(new Date())}
        title="Visão geral"
        description="Saúde, atividade e volume da sua plataforma de dados."
        actions={<Link href="/projects" className="btn btn-primary btn-sm"><FolderKanban size={16} />Ver projetos</Link>}
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Projetos" value={String(projects)} hint="projetos ativos" icon={<FolderKanban size={20} />} />
        <StatCard label="Datasets" value={String(datasets)} hint={`${tables.length} tabelas`} icon={<Database size={20} />} />
        <StatCard label="Armazenamento" value={formatBytes(bytes)} hint="dados catalogados" icon={<HardDrive size={20} />} />
        <StatCard label="Usuários" value={String(users)} hint="acessos ativos" icon={<UsersRound size={20} />} />
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        <Panel title="Uploads recentes" action={
          <div className="flex items-center gap-2">
            <CancelQueueButton queued={queued} />
            <Link href="/uploads" className="text-xs text-primary hover:underline">Ver todos</Link>
          </div>
        }>
          <div className="divide-y divide-base-300">
            {uploads.length ? uploads.map(u => (
              <div key={u.id} className="flex items-center justify-between px-5 py-3.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{u.originalFilename}</p>
                  <p className="text-xs text-base-content/50">{u.dataset?.name ?? "Destino pendente"} · {timeAgo(u.createdAt)}</p>
                </div>
                <StatusBadge status={u.status === "COMPLETED" ? "healthy" : u.status === "FAILED" ? "error" : "warning"} label={u.status} />
              </div>
            )) : <p className="p-6 text-sm text-base-content/50">Nenhum upload ainda.</p>}
          </div>
        </Panel>
        <Panel title="Auditoria recente" action={<Link href="/audit" className="text-xs text-primary hover:underline">Ver todos</Link>}>
          <div className="divide-y divide-base-300">
            {audits.map(e => (
              <div key={e.id} className="px-5 py-3">
                <p className="text-sm font-medium">{e.eventType}</p>
                <p className="text-xs text-base-content/45">{e.user?.name ?? "Token ou sistema"} · {timeAgo(e.createdAt)}</p>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}

function formatBytes(value: bigint) {
  const n = Number(value);
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 4);
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function timeAgo(date: Date) {
  return date.toLocaleDateString("pt-BR");
}
