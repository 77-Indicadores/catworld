import { NextResponse } from "next/server";
import { checkSql } from "@/server/azure/sql";
import { env } from "@/server/env";

export async function GET() {
  const e = env();
  const blobActive = !!e.CATWORLD_AZURE_BLOB_CONNECTION_STRING;

  const [sqlResult, blobResult] = await Promise.all([
    checkSql().then(r => ({ ok: true, latencyMs: r.latencyMs, database: r.database })).catch(err => ({ ok: false, error: String(err) })),
    blobActive ? testBlob(e.CATWORLD_AZURE_BLOB_CONNECTION_STRING!, e.CATWORLD_AZURE_BLOB_CONTAINER) : Promise.resolve({ ok: false, reason: "não configurado" }),
  ]);

  const commit = process.env.NEXT_PUBLIC_GIT_COMMIT ?? process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "unknown";

  return NextResponse.json({
    commit: commit.slice(0, 7),
    bulk_insert_active: blobActive && (blobResult as { ok: boolean }).ok,
    blob: blobResult,
    sql: sqlResult,
    time: new Date().toISOString(),
  });
}

async function testBlob(connStr: string, container: string) {
  try {
    const { BlobServiceClient } = await import("@azure/storage-blob");
    const client = BlobServiceClient.fromConnectionString(connStr).getContainerClient(container);
    const props = await client.getProperties();
    return { ok: true, container, lastModified: props.lastModified };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
