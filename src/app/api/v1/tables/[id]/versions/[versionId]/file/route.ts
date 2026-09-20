/**
 * GET /api/v1/tables/:id/versions/:versionId/file — baixa o ARQUIVO ORIGINAL do upload que gerou a versão.
 *
 * Exige WRITE no dataset (quem envia dados): o arquivo pode ter colunas que não foram importadas, então não é o mesmo que
 * ler a tabela. O arquivo só existe enquanto a retenção o guarda (`retention.upload_files_days` e últimas N versões):
 * depois disso é 410 GONE. Auditado como UPLOAD_FILE_DOWNLOADED.
 */
import type { NextRequest } from "next/server";
import { Readable } from "node:stream";
import { z } from "zod";
import { prisma } from "@/server/db";
import { resolveActor } from "@/server/auth/actor";
import { assertDatasetAccess } from "@/server/auth/permissions";
import { audit } from "@/server/audit";
import { ApiError, handleApiError } from "@/server/http";
import { downloadFile, fileExists } from "@/server/storage";
import { safeDownloadName } from "@/server/uploads/download-name";

const idSchema = z.string().uuid();

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; versionId: string }> }) {
  try {
    const actor = await resolveActor(request);
    const p = await params;
    const tableId = idSchema.safeParse(p.id), versionId = idSchema.safeParse(p.versionId);
    if (!tableId.success || !versionId.success) throw new ApiError(404, "NOT_FOUND", "Versão não encontrada");

    const table = await prisma.datasetTable.findUnique({ where: { id: tableId.data }, select: { id: true, dataset: { select: { id: true, projectId: true } } } });
    if (!table) throw new ApiError(404, "NOT_FOUND", "Tabela não encontrada");
    await assertDatasetAccess(actor, "WRITE", table.dataset);

    // a versão precisa ser DESTA tabela (senão daria para baixar arquivo de outra tabela trocando o id)
    const version = await prisma.datasetVersion.findFirst({ where: { id: versionId.data, tableId: table.id }, select: { uploadId: true } });
    if (!version) throw new ApiError(404, "NOT_FOUND", "Versão não encontrada");
    if (!version.uploadId) throw new ApiError(404, "NO_FILE", "Esta versão veio de uma sincronização de fonte e não tem arquivo");
    const upload = await prisma.upload.findUnique({ where: { id: version.uploadId }, select: { id: true, blobName: true, originalFilename: true } });
    if (!upload) throw new ApiError(410, "FILE_GONE", "O registro do upload já foi removido pela retenção");
    if (!fileExists(upload.blobName)) throw new ApiError(410, "FILE_GONE", "O arquivo desta versão já foi removido pela retenção");

    await audit(actor, "UPLOAD_FILE_DOWNLOADED", "upload", upload.id, { tableId: table.id, versionId: versionId.data, filename: upload.originalFilename });
    const body = Readable.toWeb(await downloadFile(upload.blobName) as Readable) as ReadableStream<Uint8Array>;
    return new Response(body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${safeDownloadName(upload.originalFilename)}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    return handleApiError(e);
  }
}
