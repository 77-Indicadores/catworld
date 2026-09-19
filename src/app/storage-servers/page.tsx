import { prisma } from "@/server/db";
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

  return <StorageServerManager initialServers={servers} />;
}
