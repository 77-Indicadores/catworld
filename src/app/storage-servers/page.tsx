import { prisma } from "@/server/db";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { StorageServerManager } from "./manager";
export const dynamic = "force-dynamic";

export default async function StorageServersPage() {
  const servers = await prisma.storageServer.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      provider: true,
      url: true,
      isDefault: true,
      active: true,
      lastStatus: true,
      lastLatencyMs: true,
      lastCheckedAt: true,
      _count: { select: { datasets: true } },
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Infraestrutura"
        title="Servidores de armazenamento"
        description="Gerencie os SQL Servers onde os dados dos datasets são armazenados."
      />
      <Panel>
        <StorageServerManager initialServers={servers} />
      </Panel>
    </div>
  );
}
