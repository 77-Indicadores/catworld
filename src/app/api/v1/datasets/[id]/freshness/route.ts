import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { resolveActor } from "@/server/auth/actor";
import { assertDatasetAccess } from "@/server/auth/permissions";
import { handleApiError, ok, publicQueryErrorMessage } from "@/server/http";

/**
 * Frescor por tabela, sem colunas nem detalhes da conexao: para monitores que checam com frequencia (antes so havia
 * `GET /datasets/:id/tables`, que traz o catalogo inteiro a cada chamada). Mesmo acesso da listagem (READ no dataset).
 *
 * `lastDataAt` = ultima carga CONCLUIDA (upload, sync ou derivada), mesmo que o conteudo seja igual ao anterior; carga que
 * falhou nao mexe nele. Para fonte de sync, `source.lastStatus`/`lastRefreshedAt` dizem se a ultima execucao deu certo.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(request);
    const datasetId = (await params).id;
    const dataset = await prisma.dataset.findUnique({ where: { id: datasetId }, select: { id: true, projectId: true } });
    if (!dataset) return ok([]); // como /tables: id desconhecido = lista vazia (nao revela se existe)
    await assertDatasetAccess(actor, "READ", dataset);
    const tables = await prisma.datasetTable.findMany({
      where: { datasetId },
      select: {
        id: true, name: true, sqlName: true, rowCount: true, lastDataAt: true,
        source: { select: { id: true, mode: true, active: true, lastStatus: true, lastRefreshedAt: true, nextRefreshAt: true, lastError: true } },
      },
      orderBy: { name: "asc" },
    });
    // erro de conexao da fonte (host, IP, firewall) nao sai para o monitor; o resto da mensagem sim
    const data = tables.map((t) => (t.source?.lastError ? { ...t, source: { ...t.source, lastError: publicQueryErrorMessage(t.source.lastError) } } : t));
    return ok(data, { serverTime: new Date().toISOString() });
  } catch (e) {
    return handleApiError(e);
  }
}
