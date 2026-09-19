import Link from "next/link";
import { CheckCircle2, FolderKanban } from "lucide-react";
import { prisma } from "@/server/db";
import { EmptyState, PageHeader, Panel, StatusBadge } from "@/components/ui/primitives";
import { presentLongDate, presentTableFreshness, type RefreshInput } from "@/lib/present";
import { summarizeFreshness, type FreshnessItem } from "@/lib/workspace/summary";
import { resolveActor } from "@/server/auth/actor";
import { visibleProjectIds } from "@/server/auth/permissions";

/** Campos de frescor de uma fonte/derivada (Prisma) no formato do apresentador. */
function toRefreshInput(x: { mode?: string | null; active?: boolean | null; lastStatus: string | null; lastError: string | null; refreshCron: string | null; nextRefreshAt: Date | null; lastRefreshedAt: Date | null }): RefreshInput {
  return { mode: x.mode ?? "extract", active: x.active ?? true, lastStatus: x.lastStatus, lastError: x.lastError, refreshCron: x.refreshCron, nextRefreshAt: x.nextRefreshAt?.toISOString() ?? null, lastRefreshedAt: x.lastRefreshedAt?.toISOString() ?? null };
}
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const actor = await resolveActor();
  const ids = await visibleProjectIds(actor);
  const projectScope = ids ? { id: { in: ids } } : {};

  // Só o que este dashboard existe pra mostrar: fontes/derivadas atrasadas ou com erro em toda a
  // plataforma. Contagens de projetos/datasets e fila de jobs já vivem em /projects e /uploads —
  // repeti-las aqui era navegação redundante, não informação nova.
  const projectsData = await prisma.project.findMany({
    where: { active: true, ...projectScope },
    orderBy: { name: "asc" },
    include: {
      datasets: {
        where: { active: true },
        include: {
          tables: { select: { id: true, name: true, lastDataAt: true, source: { select: { mode: true, active: true, lastStatus: true, lastError: true, refreshCron: true, nextRefreshAt: true, lastRefreshedAt: true } } } },
          derivedTables: { where: { active: true }, select: { targetTableId: true, active: true, lastStatus: true, lastError: true, refreshCron: true, nextRefreshAt: true, lastRefreshedAt: true } },
        },
      },
    },
  });

  // Frescor de verdade (cron, estado da fonte e da derivada), não "24 h sem dado": tabela só de upload não tem agenda.
  const now = new Date();
  const allItems: FreshnessItem[] = [];
  for (const p of projectsData) {
    for (const d of p.datasets) {
      const derivedByTarget = new Map(d.derivedTables.map((dt) => [dt.targetTableId, dt]));
      for (const t of d.tables) {
        const dt = derivedByTarget.get(t.id);
        const freshness = presentTableFreshness({
          lastDataAt: t.lastDataAt?.toISOString() ?? null,
          sources: t.source ? [toRefreshInput(t.source)] : [],
          derived: dt ? toRefreshInput({ ...dt, mode: "extract" }) : null,
        }, now);
        allItems.push({ key: t.id, name: t.name, group: `${p.name} › ${d.name}`, href: `/projects/${p.slug}`, freshness });
      }
    }
  }
  const attention = [...summarizeFreshness(allItems).failing, ...summarizeFreshness(allItems).stale];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={presentLongDate()}
        title="Precisa de atenção"
        description="Fontes e tabelas derivadas atrasadas ou com erro, em todos os seus projetos."
        actions={<Link href="/projects" className="btn btn-primary btn-sm"><FolderKanban size={16} />Ver projetos</Link>}
      />

      <Panel>
        {attention.length === 0 ? (
          <EmptyState
            icon={<CheckCircle2 size={26} />}
            title="Tudo em dia"
            description="Nenhuma fonte ou tabela derivada atrasada ou com erro no momento."
          />
        ) : (
          <ul className="divide-y divide-base-300">
            {attention.map((it) => (
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
        )}
      </Panel>
    </div>
  );
}
