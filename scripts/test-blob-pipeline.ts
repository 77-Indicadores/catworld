/**
 * Testa pipeline completo: upload de arquivo real → blob → download → parse
 * Mede latência de cada etapa
 */
import { readFileSync, existsSync, createWriteStream, statSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { resolve } from "node:path";
import { BlobServiceClient } from "@azure/storage-blob";
import { Readable } from "node:stream";

const envPath = resolve(".", ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const sep = t.indexOf("="); if (sep === -1) continue;
    const key = t.slice(0, sep).trim(); let val = t.slice(sep + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
}

function fmt(ms: number) { return ms >= 1000 ? `${(ms/1000).toFixed(1)}s` : `${ms}ms`; }
function fmtMB(bytes: number) { return `${(bytes/1024/1024).toFixed(1)}MB`; }
function fmtSpeed(bytes: number, ms: number) { return `${(bytes/1024/1024/(ms/1000)).toFixed(1)} MB/s`; }

async function containerClient() {
  const connStr = process.env["CATWORLD_AZURE_BLOB_CONNECTION_STRING"]!;
  const container = process.env["CATWORLD_AZURE_BLOB_CONTAINER"] ?? "arquivos";
  return BlobServiceClient.fromConnectionString(connStr).getContainerClient(container);
}

async function main() {
  const FILE = process.argv[2];
  if (!FILE) { console.error("Uso: npx tsx scripts/test-blob-pipeline.ts <arquivo.csv>"); process.exit(1); }
  if (!existsSync(FILE)) { console.error(`Arquivo não encontrado: ${FILE}`); process.exit(1); }

  const fileStat = statSync(FILE);
  const fileSize = fileStat.size;
  const blobName = `test-pipeline/${Date.now()}-${basename(FILE)}`;
  const cc = await containerClient();

  console.log(`\n═══════════════════════════════════════════════`);
  console.log(`  Teste de Pipeline Azure Blob`);
  console.log(`  Arquivo: ${basename(FILE)}`);
  console.log(`  Tamanho: ${fmtMB(fileSize)}`);
  console.log(`═══════════════════════════════════════════════\n`);

  const results: Record<string, { ms: number; extra?: string }> = {};

  // 1. Upload para blob
  {
    const t = Date.now();
    const { createReadStream } = await import("node:fs");
    const stream = createReadStream(FILE);
    const blockClient = cc.getBlockBlobClient(blobName);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodeStream = Readable.fromWeb(Readable.toWeb(stream) as any);
    await blockClient.uploadStream(nodeStream, 8 * 1024 * 1024, 4, {
      blobHTTPHeaders: { blobContentType: FILE.endsWith(".xlsx") ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "text/csv; charset=utf-8" }
    });
    const ms = Date.now() - t;
    results["1. Upload → blob"] = { ms, extra: fmtSpeed(fileSize, ms) };
    console.log(`✓ Upload concluído em ${fmt(ms)} (${fmtSpeed(fileSize, ms)})`);
  }

  // 2. Download do blob
  {
    const dir = await mkdtemp(join(tmpdir(), "catworld-test-"));
    const destPath = join(dir, basename(FILE));
    const t = Date.now();
    const blockClient = cc.getBlockBlobClient(blobName);
    const response = await blockClient.download();
    await pipeline(response.readableStreamBody! as NodeJS.ReadableStream, createWriteStream(destPath));
    const ms = Date.now() - t;
    results["2. Download ← blob"] = { ms, extra: fmtSpeed(fileSize, ms) };
    console.log(`✓ Download concluído em ${fmt(ms)} (${fmtSpeed(fileSize, ms)})`);
    await rm(dir, { recursive: true, force: true });
  }

  // 3. Geração de SAS URL
  {
    const t = Date.now();
    const { generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } = await import("@azure/storage-blob");
    const connStr = process.env["CATWORLD_AZURE_BLOB_CONNECTION_STRING"]!;
    const accountMatch = connStr.match(/AccountName=([^;]+)/i)!;
    const keyMatch = connStr.match(/AccountKey=([^;]+)/i)!;
    const container = process.env["CATWORLD_AZURE_BLOB_CONTAINER"] ?? "arquivos";
    const credential = new StorageSharedKeyCredential(accountMatch[1]!, keyMatch[1]!);
    const expiresOn = new Date(Date.now() + 60 * 60_000);
    generateBlobSASQueryParameters({ containerName: container, blobName, permissions: BlobSASPermissions.parse("r"), expiresOn }, credential).toString();
    const ms = Date.now() - t;
    results["3. Gerar SAS URL"] = { ms };
    console.log(`✓ SAS gerada em ${fmt(ms)}`);
  }

  // 4. Limpeza
  {
    const t = Date.now();
    await cc.deleteBlob(blobName, { deleteSnapshots: "include" });
    const ms = Date.now() - t;
    results["4. Delete blob"] = { ms };
    console.log(`✓ Delete em ${fmt(ms)}`);
  }

  // Relatório
  console.log(`\n┌─────────────────────────────────────────────────┐`);
  console.log(`│  Resultados                                     │`);
  console.log(`├─────────────────────────────────────────────────┤`);
  for (const [label, { ms, extra }] of Object.entries(results)) {
    const row = `│  ${label.padEnd(28)} ${fmt(ms).padStart(8)}  ${(extra ?? "").padEnd(10)}│`;
    console.log(row);
  }
  console.log(`└─────────────────────────────────────────────────┘\n`);
}

void main().catch(e => { console.error("❌", e.message); process.exit(1); });
