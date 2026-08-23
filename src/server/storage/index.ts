import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { writeLocal, downloadLocal } from "./local";
import { env } from "@/server/env";

export async function writeFile(blobName: string, body: ReadableStream<Uint8Array>) {
  return writeLocal(blobName, body);
}

export async function downloadFile(blobName: string): Promise<NodeJS.ReadableStream> {
  return downloadLocal(blobName) as unknown as NodeJS.ReadableStream;
}

export async function deleteFile(blobName: string) {
  try {
    const path = resolve(env().CATWORLD_UPLOAD_DIR, blobName);
    if (existsSync(path)) unlinkSync(path);
  } catch { /* best-effort */ }
}

export async function uploadTarget(uploadId: string) {
  return { url: `/api/v1/uploads/${uploadId}`, expiresAt: new Date(Date.now() + 15 * 60_000) };
}
