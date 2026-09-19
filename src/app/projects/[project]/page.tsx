import { notFound } from "next/navigation";
import { prisma } from "@/server/db";
import { ProjectWorkspace } from "@/components/workspace/project-workspace";
import { resolveActor } from "@/server/auth/actor";
import { visibleProjectIds } from "@/server/auth/permissions";
import { env } from "@/server/env";
import { WORKSPACE_INCLUDE, loadLastUploads, serializeWorkspaceProject } from "@/lib/workspace/serialize";
export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ project: string }> }) {
  const actor = await resolveActor(), ids = await visibleProjectIds(actor);
  const [p, storageServers] = await Promise.all([
    prisma.project.findFirst({
      where: { slug: (await params).project, ...(ids ? { id: { in: ids } } : {}) },
      include: WORKSPACE_INCLUDE,
    }),
    prisma.storageServer.findMany({ where: { active: true }, select: { id: true, name: true, isDefault: true }, orderBy: { createdAt: "asc" } }),
  ]);
  if (!p) notFound();
  const lastUploads = await loadLastUploads(p.datasets.flatMap((d) => d.tables.map((t) => t.id)));
  const project = serializeWorkspaceProject(p, lastUploads);
  const publicOrigin = env().CATWORLD_PUBLIC_ORIGIN ?? "";
  return <ProjectWorkspace project={project} publicOrigin={publicOrigin} storageServers={storageServers} />;
}
