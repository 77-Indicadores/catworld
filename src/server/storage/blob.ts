import { BlobServiceClient } from "@azure/storage-blob";
import { Readable } from "node:stream";
import { env } from "@/server/env";

function containerClient() {
  const e = env();
  const service = BlobServiceClient.fromConnectionString(e.CATWORLD_AZURE_BLOB_CONNECTION_STRING!);
  return service.getContainerClient(e.CATWORLD_AZURE_BLOB_CONTAINER);
}

export async function writeBlob(blobName: string, body: ReadableStream<Uint8Array>) {
  const client = containerClient().getBlockBlobClient(blobName);
  const stream = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
  await client.uploadStream(stream, 8 * 1024 * 1024, 4);
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

export async function ensureContainer() {
  await containerClient().createIfNotExists();
}

export async function generateBlobSasUrl(blobName: string, expiryMs = 60 * 60_000): Promise<string> {
  const { generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } = await import("@azure/storage-blob");
  const e = env();
  const connStr = e.CATWORLD_AZURE_BLOB_CONNECTION_STRING!;
  const accountMatch = connStr.match(/AccountName=([^;]+)/i);
  const keyMatch = connStr.match(/AccountKey=([^;]+)/i);
  if (!accountMatch || !keyMatch) throw new Error("Connection string inválida para gerar SAS");
  const credential = new StorageSharedKeyCredential(accountMatch[1]!, keyMatch[1]!);
  const expiresOn = new Date(Date.now() + expiryMs);
  const sas = generateBlobSASQueryParameters(
    { containerName: e.CATWORLD_AZURE_BLOB_CONTAINER, blobName, permissions: BlobSASPermissions.parse("r"), expiresOn },
    credential
  );
  return `https://${accountMatch[1]!}.blob.core.windows.net/${e.CATWORLD_AZURE_BLOB_CONTAINER}/${blobName}?${sas}`;
}
