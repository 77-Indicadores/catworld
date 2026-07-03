import { env } from "@/server/env";
import { writeLocal, downloadLocal } from "./local";
import { writeBlob, downloadBlob } from "./blob";

function usesBlob() {
  return !!env().CATWORLD_AZURE_BLOB_CONNECTION_STRING;
}

export async function writeFile(blobName: string, body: ReadableStream<Uint8Array>) {
  if (usesBlob()) return writeBlob(blobName, body);
  return writeLocal(blobName, body);
}

export async function downloadFile(blobName: string): Promise<NodeJS.ReadableStream> {
  if (usesBlob()) return downloadBlob(blobName);
  return downloadLocal(blobName) as unknown as NodeJS.ReadableStream;
}

export async function uploadTarget(uploadId: string) {
  return { url: `/api/v1/uploads/${uploadId}/file`, expiresAt: new Date(Date.now() + 15 * 60_000) };
}
