import type { NextRequest } from "next/server";
import { resolveActor } from "@/server/auth/actor";
import { handleApiError, ok } from "@/server/http";
import { assertUploadWrite } from "@/server/uploads/access";
import { FROM_UPLOADED, queuePreviewUpload } from "@/server/uploads/actions";

export async function POST(r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(r);
    await assertUploadWrite(actor, (await params).id);
    return ok(await queuePreviewUpload((await params).id, FROM_UPLOADED), undefined, 202);
  } catch (e) {
    return handleApiError(e);
  }
}
