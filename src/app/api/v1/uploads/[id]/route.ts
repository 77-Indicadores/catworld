import type { NextRequest } from "next/server";
import { createGunzip } from "node:zlib";
import { extname } from "node:path";
import { Readable } from "node:stream";
import { prisma } from "@/server/db";
import { resolveActor } from "@/server/auth/actor";
import { hasAnyWriteGrant } from "@/server/auth/permissions";
import { writeFile, copyFile } from "@/server/storage";
import { ApiError, handleApiError, ok } from "@/server/http";
import { confirmUploadSchema, queueImportUpload, queuePreviewUpload } from "@/server/uploads/actions";

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
    // Immediately copy to originals/ so the blob survives any lifecycle policy on uploads/ prefix
    const ext = extname(upload.originalFilename).toLowerCase();
    await copyFile(upload.blobName, `originals/${upload.id}${ext}`).catch((e) => {
      console.error("[PUT upload] originals/ copy failed for", upload.id, e instanceof Error ? e.message : e);
    });
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
      // If the client already computed the preview (e.g. via DuckDB-WASM), skip the PREVIEW_UPLOAD
      // job and go straight to import. Requires previewJson + mappingJson + datasetId on the upload.
      const upload = await prisma.upload.findUniqueOrThrow({
        where: { id },
        select: { previewJson: true, mappingJson: true, datasetId: true },
      });
      if (upload.previewJson && upload.mappingJson && upload.datasetId) {
        const { queueImportUploadAuto } = await import("@/server/uploads/actions");
        const mapping = JSON.parse(upload.mappingJson) as { originalName: string; sqlName: string; sqlType: string; nullable: boolean }[];
        return ok(await queueImportUploadAuto(id, mapping), undefined, 202);
      }
      return ok(await queuePreviewUpload(id), undefined, 202);
    }

    if (action === "confirm") {
      const input = confirmUploadSchema.parse(await r.json());
      return ok(await queueImportUpload(actor, id, input), undefined, 202);
    }

    if (action === "retry") {
      const upload = await prisma.upload.findUniqueOrThrow({
        where: { id },
        select: { status: true, mappingJson: true, previewJson: true, datasetId: true },
      });
      if (upload.status !== "FAILED") throw new ApiError(409, "NOT_RETRYABLE", "Upload não está em estado de falha");
      await prisma.job.updateMany({ where: { uploadId: id, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "FAILED", lastError: "Superseded by retry" } });
      if (upload.mappingJson && upload.previewJson && upload.datasetId) {
        const { queueImportUploadAuto } = await import("@/server/uploads/actions");
        const mapping = JSON.parse(upload.mappingJson) as { originalName: string; sqlName: string; sqlType: string; nullable: boolean }[];
        return ok(await queueImportUploadAuto(id, mapping), undefined, 202);
      }
      return ok(await queuePreviewUpload(id), undefined, 202);
    }

    if (action === "cancel") {
      const CANCELLABLE = ["PENDING_UPLOAD","QUEUED_PREVIEW","PREVIEWING","AWAITING_CONFIRMATION","QUEUED_IMPORT","IMPORTING","RETRYING"];
      const upload = await prisma.upload.findUniqueOrThrow({ where: { id }, select: { status: true } });
      if (!CANCELLABLE.includes(upload.status)) throw new ApiError(409, "NOT_CANCELLABLE", "Upload não pode ser cancelado no status atual");
      await prisma.$transaction(async (tx) => {
        await tx.upload.update({ where: { id }, data: { status: "FAILED", errorMessage: "Cancelado pelo usuário" } });
        await tx.job.updateMany({ where: { uploadId: id, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "FAILED", lastError: "Cancelled" } });
      });
      return ok({ cancelled: true });
    }

    throw new ApiError(400, "INVALID_ACTION", "Ação de upload inválida");
  } catch (e) {
    return handleApiError(e);
  }
}
