import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { BlobServiceClient } from "@azure/storage-blob";

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

async function main() {
  const connStr = process.env["CATWORLD_AZURE_BLOB_CONNECTION_STRING"];
  const container = process.env["CATWORLD_AZURE_BLOB_CONTAINER"] ?? "arquivos";

  if (!connStr) { console.error("CATWORLD_AZURE_BLOB_CONNECTION_STRING não configurada"); process.exit(1); }

  console.log(`\nTestando Azure Blob Storage...`);
  console.log(`Container: ${container}\n`);

  const service = BlobServiceClient.fromConnectionString(connStr);
  const containerClient = service.getContainerClient(container);

  // 1. Verifica/cria container
  const exists = await containerClient.exists();
  if (exists) {
    console.log(`✓ Container '${container}' encontrado`);
  } else {
    console.log(`  Container '${container}' não existe — criando...`);
    await containerClient.create();
    console.log(`✓ Container '${container}' criado`);
  }

  // 2. Upload de blob de teste
  const testBlob = `test-conexao-${Date.now()}.txt`;
  const blockClient = containerClient.getBlockBlobClient(testBlob);
  await blockClient.upload("catworld blob test ok", 20);
  console.log(`✓ Upload OK  →  ${testBlob}`);

  // 3. Download e verifica conteúdo
  const download = await blockClient.downloadToBuffer();
  const content = download.toString("utf8");
  if (content !== "catworld blob test ok") throw new Error(`Conteúdo inesperado: ${content}`);
  console.log(`✓ Download OK  →  conteúdo verificado`);

  // 4. Deleta blob de teste
  await blockClient.delete();
  console.log(`✓ Delete OK`);

  // 5. Latência
  const t = Date.now();
  await containerClient.getProperties();
  console.log(`✓ Latência: ${Date.now() - t}ms`);

  console.log(`\n✅ Azure Blob Storage operacional — pronto para uso!\n`);
}

void main().catch(e => { console.error("\n❌ Erro:", e.message); process.exit(1); });
