import * as Sentry from "@sentry/nextjs";
import {
  BlobServiceClient,
  BlobSASPermissions,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
} from "@azure/storage-blob";
import { Readable } from "node:stream";
import type { Readable as NodeReadable } from "node:stream";
import { extname } from "node:path";
import { env } from "@/server/env";

const MIME: Record<string, string> = {
  ".csv": "text/csv; charset=utf-8",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".tsv": "text/tab-separated-values; charset=utf-8",
};

function containerClient() {
  const e = env();
  const service = BlobServiceClient.fromConnectionString(e.CATWORLD_AZURE_BLOB_CONNECTION_STRING!);
  return service.getContainerClient(e.CATWORLD_AZURE_BLOB_CONTAINER);
}

function sharedKeyCredential(): StorageSharedKeyCredential {
  const connStr = env().CATWORLD_AZURE_BLOB_CONNECTION_STRING!;
  const accountMatch = connStr.match(/AccountName=([^;]+)/i);
  const keyMatch = connStr.match(/AccountKey=([^;]+)/i);
  if (!accountMatch || !keyMatch) throw new Error("Connection string inválida para gerar SAS");
  return new StorageSharedKeyCredential(accountMatch[1]!, keyMatch[1]!);
}

export async function writeBlob(blobName: string, body: ReadableStream<Uint8Array>) {
  const client = containerClient().getBlockBlobClient(blobName);
  const stream = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
  const contentType = MIME[extname(blobName).toLowerCase()] ?? "application/octet-stream";
  await client.uploadStream(stream, 8 * 1024 * 1024, 4, {
    blobHTTPHeaders: { blobContentType: contentType },
  });
}

export async function downloadBlob(blobName: string): Promise<NodeJS.ReadableStream> {
  const client = containerClient().getBlockBlobClient(blobName);
  const response = await client.download();
  if (!response.readableStreamBody) throw new Error(`Blob não encontrado: ${blobName}`);
  return response.readableStreamBody;
}

export async function deleteBlob(blobName: string) {
  await containerClient().deleteBlob(blobName, { deleteSnapshots: "include" }).catch(() => undefined);
}

export async function copyBlob(sourceBlobName: string, destBlobName: string) {
  const container = containerClient();
  const sourceClient = container.getBlockBlobClient(sourceBlobName);
  const destClient = container.getBlockBlobClient(destBlobName);
  // Download + re-upload: avoids SAS URL generation and works with any credential format
  let response;
  try {
    response = await sourceClient.download();
  } catch (e) {
    Sentry.withScope((scope) => {
      scope.setContext("blob", { src: sourceBlobName, dst: destBlobName, op: "download" });
      Sentry.captureException(e);
    });
    throw e;
  }
  if (!response.readableStreamBody) throw new Error(`Blob source not found: ${sourceBlobName}`);
  try {
    await destClient.uploadStream(response.readableStreamBody as NodeReadable, 8 * 1024 * 1024, 4, {
      blobHTTPHeaders: { blobContentType: response.contentType ?? "application/octet-stream" },
    });
  } catch (e) {
    Sentry.withScope((scope) => {
      scope.setContext("blob", { src: sourceBlobName, dst: destBlobName, op: "upload" });
      Sentry.captureException(e);
    });
    throw e;
  }
}

export async function ensureContainer() {
  await containerClient().createIfNotExists();
}

export function generateBlobSasUrl(blobName: string, expiryMs = 60 * 60_000): string {
  const e = env();
  const credential = sharedKeyCredential();
  const expiresOn = new Date(Date.now() + expiryMs);
  const sas = generateBlobSASQueryParameters(
    { containerName: e.CATWORLD_AZURE_BLOB_CONTAINER, blobName, permissions: BlobSASPermissions.parse("r"), expiresOn },
    credential
  );
  const accountName = e.CATWORLD_AZURE_BLOB_CONNECTION_STRING!.match(/AccountName=([^;]+)/i)![1]!;
  return `https://${accountName}.blob.core.windows.net/${e.CATWORLD_AZURE_BLOB_CONTAINER}/${blobName}?${sas}`;
}

export function blobAccountName(): string {
  return env().CATWORLD_AZURE_BLOB_CONNECTION_STRING!.match(/AccountName=([^;]+)/i)![1]!;
}
