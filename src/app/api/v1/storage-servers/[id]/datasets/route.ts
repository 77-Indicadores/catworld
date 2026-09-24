/**
 * GET /api/v1/storage-servers/[id]/datasets
 *
 * Quais datasets (de qual projeto) estão neste servidor — a contagem em
 * `_count.datasets` (listagem de storage-servers) não diz QUAIS, o que torna
 * impossível auditar fragmentação (um projeto com datasets espalhados entre
 * servidores) sem abrir projeto por projeto. Este endpoint existe só pra isso.
 */
import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { handleApiError, ok } from "@/server/http";

export async function GET(r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(r);
    requireRole(actor, ["ADMIN"]);
    const id = (await params).id;

    const datasets = await prisma.dataset.findMany({
      where: { storageServerId: id, active: true },
      select: { id: true, name: true, project: { select: { id: true, name: true, slug: true } } },
      orderBy: [{ project: { name: "asc" } }, { name: "asc" }],
    });

    return ok({ datasets });
  } catch (e) {
    return handleApiError(e);
  }
}
