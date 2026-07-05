import type { NextRequest } from "next/server";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { z } from "zod";
import { prisma } from "@/server/db";
import { resolveActor } from "@/server/auth/actor";
import { canAccess, hasAnyWriteGrant } from "@/server/auth/permissions";
import { writeFile } from "@/server/storage";
import { ApiError, handleApiError, ok } from "@/server/http";

export async function GET(r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await resolveActor(r);
    return ok(await prisma.upload.findUniqueOrThrow({ where: { id: (await params).id }, include: { dataset: true, table: true, jobs: true } }));
  } catch (e) {
    return handleApiError(e);
  }
}

export async function PUT(r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(r);
    if (!await hasAnyWriteGrant(actor)) throw new ApiError(403, "FORBIDDEN", "Permissão insuficiente");
    const upload = await prisma.upload.findUniqueOrThrow({ where: { id: (await params).id } });
    if (!r.body) throw new ApiError(400, "EMPTY_BODY", "Corpo da requisição vazio");

    let body: ReadableStream<Uint8Array> = r.body;
    if (r.headers.get("content-encoding") === "gzip") {
      const gunzip = createGunzip();
      Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]).pipe(gunzip);
      body = Readable.toWeb(gunzip) as ReadableStream<Uint8Array>;
    }

    await writeFile(upload.blobName, body);
    return ok({ stored: true });
  } catch (e) {
    return handleApiError(e);
  }
}
export async function POST(r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(r);
    const id = (await params).id;
    const action = r.nextUrl.searchParams.get("action");

    if (action === "uploaded") {
      const [, job] = await prisma.$transaction([
        prisma.upload.update({ where: { id }, data: { status: "QUEUED_PREVIEW", progress: 5 } }),
        prisma.job.create({ data: { type: "PREVIEW_UPLOAD", uploadId: id } }),
      ]);
      return ok(job, undefined, 202);
    }

    if (action === "confirm") {
      const input = z.object({
        datasetId: z.string().uuid(),
        tableId: z.string().uuid().nullable().optional(),
        mode: z.enum(["replace", "append", "upsert"]),
        keyColumn: z.string().nullable().optional(),
        mapping: z.array(z.object({ originalName: z.string(), sqlName: z.string(), sqlType: z.string(), nullable: z.boolean() })).min(1, "Mapeamento n?o pode estar vazio"),
        deltaToDelete: z.array(z.string().regex(/^[0-9a-f]{32}$/, "Hash inv?lido")).optional(),
      }).parse(await r.json());

      const dataset = await prisma.dataset.findUnique({ where: { id: input.datasetId } });
      if (!dataset) throw new ApiError(404, "DATASET_NOT_FOUND", "Dataset não encontrado");
      if (!await canAccess(actor, "WRITE", dataset.projectId, dataset.id)) {
        throw new ApiError(403, "FORBIDDEN", "Permiss?o insuficiente para este dataset");
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
          },
        }),
        prisma.job.create({ data: { type: "IMPORT_UPLOAD", uploadId: id, maxAttempts: 5 } }),
      ]);
      return ok(job, undefined, 202);
    }

    throw new ApiError(400, "INVALID_ACTION", "A??o de upload inv?lida");
  } catch (e) {
    return handleApiError(e);
  }
}
