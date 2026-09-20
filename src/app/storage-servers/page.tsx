import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { auditPageRead } from "@/server/audit-request";
import { StorageServerManager } from "./manager";
export const dynamic = "force-dynamic";

export default async function StorageServersPage() {
  // A página entrega a URL de conexão (com credenciais) ao cliente para edição: mesmo
  // gate da API (/api/v1/storage-servers = ADMIN) e leitura auditada (ADMIN_READ).
  const actor = await resolveActor();
  requireRole(actor, ["ADMIN"]);
  auditPageRead(actor, "/storage-servers");

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
