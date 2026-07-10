import { notFound } from "next/navigation";
import { prisma } from "@/server/db";
import { ProjectWorkspace } from "@/components/workspace/project-workspace";
import { resolveActor } from "@/server/auth/actor";
import { visibleProjectIds } from "@/server/auth/permissions";
import { env } from "@/server/env";
export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ project: string }> }) {
  const actor = await resolveActor(), ids = await visibleProjectIds(actor);
  const p = await prisma.project.findFirst({
    where: { slug: (await params).project, ...(ids ? { id: { in: ids } } : {}) },
    include: { datasets: { where: { active: true }, include: { tables: { include: { columns: { orderBy: { ordinal: "asc" } }, source: { include: { connection: true } } } } } } },
  });
  if (!p) notFound();
  const project = {
    id: p.id,
    slug: p.slug,
    name: p.name,
    description: p.description,
    active: p.active,
    datasets: p.datasets.map((d) => ({
      id: d.id,
      slug: d.slug,
      name: d.name,
      description: d.description,
      active: d.active,
      schemaName: d.schemaName,
      tables: d.tables.map((t) => ({
        id: t.id,
        name: t.name,
        sqlName: t.sqlName,
        rowCount: String(t.rowCount),
        lastDataAt: t.lastDataAt?.toISOString() ?? null,
        source: t.source ? {
          id: t.source.id,
          name: t.source.name,
          mode: t.source.mode,
          sourceKind: t.source.sourceKind,
          sourceSchema: t.source.sourceSchema,
          sourceTable: t.source.sourceTable,
          refreshPolicy: t.source.refreshPolicy,
          lastStatus: t.source.lastStatus,
          lastRowCount: t.source.lastRowCount ? String(t.source.lastRowCount) : null,
          lastError: t.source.lastError,
          active: t.source.active,
          lastRefreshedAt: t.source.lastRefreshedAt?.toISOString() ?? null,
          nextRefreshAt: t.source.nextRefreshAt?.toISOString() ?? null,
          connection: { id: t.source.connection.id, name: t.source.connection.name },
        } : null,
        columns: t.columns.map((c) => ({ id: c.id, sqlName: c.sqlName, originalName: c.originalName, sqlType: c.sqlType, nullable: c.nullable })),
      })),
    })),
  };
  const publicOrigin = env().CATWORLD_PUBLIC_ORIGIN ?? "";
  return <ProjectWorkspace project={project} publicOrigin={publicOrigin} />;
}
