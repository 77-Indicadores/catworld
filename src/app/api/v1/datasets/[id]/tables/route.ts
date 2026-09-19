import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { resolveActor } from "@/server/auth/actor";
import { assertDatasetAccess } from "@/server/auth/permissions";
import { handleApiError, ok } from "@/server/http";

// Antes so exigia login: qualquer principal listava tabelas, colunas e origem de QUALQUER dataset.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(request);
    const datasetId = (await params).id;
    const dataset = await prisma.dataset.findUnique({ where: { id: datasetId }, select: { id: true, projectId: true } });
    if (!dataset) return ok([]); // como antes: id desconhecido = lista vazia (nao revela se existe)
    await assertDatasetAccess(actor, "READ", dataset);
    return ok(await prisma.datasetTable.findMany({
      where: { datasetId },
      include: { columns: true, source: { include: { connection: { select: { id: true, name: true, provider: true } } } } },
      orderBy: { name: "asc" },
    }));
  } catch (e) {
    return handleApiError(e);
  }
}
