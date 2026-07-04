import type { NextRequest } from "next/server";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { prisma } from "@/server/db";
import { resolveActor } from "@/server/auth/actor";
import { hasAnyWriteGrant } from "@/server/auth/permissions";
import { writeFile } from "@/server/storage";
import { ApiError, handleApiError, ok } from "@/server/http";

export async function PUT(r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(r);
    if (!await hasAnyWriteGrant(actor)) throw new ApiError(403, "FORBIDDEN", "Permissão insuficiente");
    const id = (await params).id;
    const upload = await prisma.upload.findUniqueOrThrow({ where: { id } });
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
