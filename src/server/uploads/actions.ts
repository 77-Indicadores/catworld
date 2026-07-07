import { z } from "zod";
import { prisma } from "@/server/db";
import { canAccess } from "@/server/auth/permissions";
import { ApiError } from "@/server/http";
import type { Actor } from "@/server/auth/actor";

const columnSchema = z.object({
  originalName: z.string(),
  sqlName: z.string(),
  sqlType: z.string(),
  nullable: z.boolean(),
});

export const confirmUploadSchema = z.object({
  datasetId: z.string().uuid(),
  tableId: z.string().uuid().nullable().optional(),
  mode: z.enum(["replace", "append", "upsert"]),
  keyColumn: z.string().nullable().optional(),
  mapping: z.array(columnSchema).min(1, "Mapeamento não pode estar vazio"),
  deltaToDelete: z.array(z.string().regex(/^[0-9a-f]{32}$/, "Hash inválido")).optional(),
});

export async function queuePreviewUpload(id: string) {
  const [, job] = await prisma.$transaction([
    prisma.upload.update({
      where: { id },
      data: { status: "QUEUED_PREVIEW", progress: 5, errorMessage: null },
    }),
    prisma.job.create({ data: { type: "PREVIEW_UPLOAD", uploadId: id } }),
  ]);
  return job;
}

export async function queueImportUploadAuto(uploadId: string, mapping: z.infer<typeof confirmUploadSchema>["mapping"]) {
  const upload = await prisma.upload.findUniqueOrThrow({ where: { id: uploadId }, select: { datasetId: true, tableId: true, mode: true, keyColumn: true } });
  if (!upload.datasetId) throw new Error("Upload sem dataset definido — não é possível auto-confirmar");
  const [, job] = await prisma.$transaction([
    prisma.upload.update({
      where: { id: uploadId },
      data: { mappingJson: JSON.stringify(mapping), status: "QUEUED_IMPORT", progress: 25, errorMessage: null },
    }),
    prisma.job.create({ data: { type: "IMPORT_UPLOAD", uploadId, maxAttempts: 5 } }),
  ]);
  return job;
}

export async function queueImportUpload(actor: Actor, id: string, input: z.infer<typeof confirmUploadSchema>) {
  const dataset = await prisma.dataset.findUnique({ where: { id: input.datasetId } });
  if (!dataset) throw new ApiError(404, "DATASET_NOT_FOUND", "Dataset não encontrado");
  if (!await canAccess(actor, "WRITE", dataset.projectId, dataset.id)) {
    throw new ApiError(403, "FORBIDDEN", "Permissão insuficiente para este dataset");
  }

  const [, job] = await prisma.$transaction([
    prisma.upload.update({
      where: { id },
      data: {
        datasetId: input.datasetId,
        tableId: input.tableId ?? null,
        mode: input.mode,
        keyColumn: input.keyColumn ?? null,
        mappingJson: JSON.stringify(input.mapping),
        deltaJson: input.deltaToDelete ? JSON.stringify(input.deltaToDelete) : null,
        status: "QUEUED_IMPORT",
        progress: 25,
        errorMessage: null,
      },
    }),
    prisma.job.create({ data: { type: "IMPORT_UPLOAD", uploadId: id, maxAttempts: 5 } }),
  ]);
  return job;
}
