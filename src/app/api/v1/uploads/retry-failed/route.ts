import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { queueImportUploadAuto, queuePreviewUpload } from "@/server/uploads/actions";
import type { ParsedColumn } from "@/server/uploads/parser";

export async function POST() {
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

  return NextResponse.json({ retried });
}
