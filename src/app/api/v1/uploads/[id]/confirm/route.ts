import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/server/db";
import { resolveActor } from "@/server/auth/actor";
import { canAccess } from "@/server/auth/permissions";
import { ApiError, handleApiError, ok } from "@/server/http";

export async function POST(r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const a = await resolveActor(r);
    const id = (await params).id;
    const i = z.object({
      datasetId: z.string().uuid(),
      tableId: z.string().uuid().nullable().optional(),
      mode: z.enum(["replace", "append", "upsert"]),
      keyColumn: z.string().nullable().optional(),
      mapping: z.array(z.object({ originalName: z.string(), sqlName: z.string(), sqlType: z.string(), nullable: z.boolean() })).min(1, "Mapeamento não pode estar vazio"),
      // Phase 2: hashes present in server but NOT in new file (rows to delete)
      deltaToDelete: z.array(z.string().regex(/^[0-9a-f]{32}$/, "Hash inválido")).optional(),
    }).parse(await r.json());

    const dataset = await prisma.dataset.findUnique({ where: { id: i.datasetId } });
    if (!dataset) throw new ApiError(404, "DATASET_NOT_FOUND", "Dataset não encontrado");
    if (!await canAccess(a, "WRITE", dataset.projectId, dataset.id))
      throw new ApiError(403, "FORBIDDEN", "Permissão insuficiente para este dataset");

    const [, job] = await prisma.$transaction([
      prisma.upload.update({
        where: { id },
        data: {
          datasetId: i.datasetId,
          tableId: i.tableId ?? null,
          mode: i.mode,
          keyColumn: i.keyColumn ?? null,
          mappingJson: JSON.stringify(i.mapping),
          deltaJson: i.deltaToDelete ? JSON.stringify(i.deltaToDelete) : null,
          status: "QUEUED_IMPORT",
          progress: 25,
        },
      }),
      prisma.job.create({ data: { type: "IMPORT_UPLOAD", uploadId: id, maxAttempts: 5 } }),
    ]);
    return ok(job, undefined, 202);
  } catch (e) {
    return handleApiError(e);
  }
}
