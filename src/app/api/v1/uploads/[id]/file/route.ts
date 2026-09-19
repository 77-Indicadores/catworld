import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { resolveActor } from "@/server/auth/actor";
import { assertUploadWrite } from "@/server/uploads/access";
import { ApiError, handleApiError, ok } from "@/server/http";
import { storeUploadBody } from "@/server/uploads/store-upload-body";

export async function PUT(r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(r);
    const id = (await params).id;
    await assertUploadWrite(actor, id);
    const upload = await prisma.upload.findUniqueOrThrow({ where: { id } });
    if (!r.body) throw new ApiError(400, "EMPTY_BODY", "Corpo da requisição vazio");

    return ok(await storeUploadBody(upload, r.body, r.headers.get("content-encoding")));
  } catch (e) {
    return handleApiError(e);
  }
}
