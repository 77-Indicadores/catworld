import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { handleApiError, ok } from "@/server/http";
import { queueImportUploadAuto, queuePreviewUpload } from "@/server/uploads/actions";
import type { ParsedColumn } from "@/server/uploads/parser";

// Acao GLOBAL: so ADMIN e DATA_MANAGER.
export async function POST(request: NextRequest) {
  try {
    requireRole(await resolveActor(request), ["ADMIN", "DATA_MANAGER"]);
    const failed = await prisma.upload.findMany({
      where: { status: "FAILED" },
      select: { id: true, mappingJson: true, previewJson: true, datasetId: true },
    });

    let retried = 0;
    for (const upload of failed) {
      try {
        if (upload.mappingJson && upload.previewJson && upload.datasetId) {
          const mapping = JSON.parse(upload.mappingJson) as ParsedColumn[];
          await queueImportUploadAuto(upload.id, mapping);
        } else {
          await queuePreviewUpload(upload.id);
        }
        retried++;
      } catch (e) {
        console.warn("[retry-failed] upload=%s error=%s", upload.id, e instanceof Error ? e.message : e);
      }
    }

    return ok({ retried });
  } catch (e) {
    return handleApiError(e);
  }
}
