/**
 * BULK INSERT from Azure Blob — substitui o TDS bulk copy para imports CSV.
 * SQL Server lê o arquivo diretamente na rede interna Azure (sem TDS overhead).
 *
 * Requer ONE-TIME setup no banco (já executado):
 *   CREATE MASTER KEY ENCRYPTION BY PASSWORD = 'CatWorld_Mk2024!';
 *
 * Ativo automaticamente quando CATWORLD_AZURE_BLOB_CONNECTION_STRING está configurado.
 *
 * Formato de saída: CSV com pipe (|) como separador de campo e aspas duplas para NVARCHAR.
 * Isso garante que qualquer conteúdo (tabs, quebras de linha, vírgulas) seja tratado corretamente.
 */
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { BlobServiceClient, BlobSASPermissions, StorageSharedKeyCredential, generateBlobSASQueryParameters } from "@azure/storage-blob";
import { sqlPool } from "@/server/azure/sql";
import { quoteIdentifier } from "@/server/security/naming";
import { rowsFromFile, type ParsedColumn } from "./parser";
import { env } from "@/server/env";

function blobEnv() {
  const e = env();
  const connStr = e.CATWORLD_AZURE_BLOB_CONNECTION_STRING!;
  const accountMatch = connStr.match(/AccountName=([^;]+)/i)!;
  const keyMatch = connStr.match(/AccountKey=([^;]+)/i)!;
  return { connStr, account: accountMatch[1]!, key: keyMatch[1]!, container: e.CATWORLD_AZURE_BLOB_CONTAINER };
}

// Conversor que gera CSV seguro: strings entre aspas duplas, numéricos sem aspas
function makeCleanConverter(type: string): (v: unknown) => string {
  if (type === "BIGINT") {
    return v => (v == null || String(v).trim() === "") ? "" : String(v).trim();
  }
  if (type.startsWith("DECIMAL")) {
    return v => {
      if (v == null || String(v).trim() === "") return "";
      const s = String(v).trim();
      const num = Number(s.includes(",") ? s.replaceAll(".", "").replace(",", ".") : s);
      return isNaN(num) ? "" : num.toFixed(4);
    };
  }
  if (type === "DATE") {
    return v => {
      if (v == null || String(v).trim() === "") return "";
      const s = String(v).trim();
      const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
      return br ? `${br[3]}-${br[2]}-${br[1]}` : s.slice(0, 10);
    };
  }
  if (type === "DATETIME2") {
    return v => {
      if (v == null || String(v).trim() === "") return "";
      const s = String(v).trim();
      const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})(.*)/);
      const iso = br ? `${br[3]}-${br[2]}-${br[1]}${br[4]}` : s;
      return new Date(iso).toISOString().replace("T", " ").replace("Z", "");
    };
  }
  if (type === "TIME") {
    return v => (v == null || String(v).trim() === "") ? "" : String(v).trim();
  }
  // NVARCHAR — com aspas duplas; aspas internas escapadas como ""
  return v => {
    if (v == null || String(v).trim() === "") return '""';
    return '"' + String(v).replace(/"/g, '""') + '"';
  };
}

export async function bulkInsertFromBlob(
  uploadId: string,
  filePath: string,
  mapping: ParsedColumn[],
  schema: string,
  stagingTable: string,
  onProgress?: (rows: number) => void
): Promise<number> {
  const { connStr, account, key, container } = blobEnv();
  const cleanBlobName = `tmp/bulk-${uploadId}.csv`;

  const service = BlobServiceClient.fromConnectionString(connStr);
  const blockClient = service.getContainerClient(container).getBlockBlobClient(cleanBlobName);
  const converters = mapping.map(c => makeCleanConverter(c.sqlType));

  // Stream: lê arquivo → converte → CSV com pipe → blob (tudo em memória mínima)
  let total = 0;
  const passThrough = new PassThrough();
  const uploadPromise = blockClient.uploadStream(passThrough, 8 * 1024 * 1024, 4, {
    blobHTTPHeaders: { blobContentType: "text/csv; charset=utf-8" },
  });

  for await (const row of rowsFromFile(filePath, mapping)) {
    passThrough.write(converters.map((fn, i) => fn(row[mapping[i]!.sqlName])).join("|") + "\n");
    total++;
    if (total % 50_000 === 0) onProgress?.(total);
  }
  passThrough.end();
  await uploadPromise;

  // SAS de 30 min para este blob temporário
  const credential = new StorageSharedKeyCredential(account, key);
  const sas = generateBlobSASQueryParameters(
    { containerName: container, blobName: cleanBlobName, permissions: BlobSASPermissions.parse("r"), expiresOn: new Date(Date.now() + 30 * 60_000) },
    credential
  ).toString();

  const pool = await sqlPool();
  const hash = createHash("md5").update(uploadId).digest("hex").slice(0, 8);
  const tempCred = `CatworldBulkCred_${hash}`;
  const tempDs = `CatworldBulkDS_${hash}`;

  try {
    await pool.request().query(`
      CREATE DATABASE SCOPED CREDENTIAL [${tempCred}]
      WITH IDENTITY = 'SHARED ACCESS SIGNATURE', SECRET = '${sas}'
    `);
    await pool.request().query(`
      CREATE EXTERNAL DATA SOURCE [${tempDs}]
      WITH (TYPE = BLOB_STORAGE, LOCATION = 'https://${account}.blob.core.windows.net', CREDENTIAL = [${tempCred}])
    `);
    await pool.request().query(`
      BULK INSERT ${quoteIdentifier(schema)}.${quoteIdentifier(stagingTable)}
      FROM '${container}/${cleanBlobName}'
      WITH (
        DATA_SOURCE = '${tempDs}',
        FORMAT = 'CSV',
        FIELDTERMINATOR = '|',
        ROWTERMINATOR = '\n',
        FIELDQUOTE = '"',
        FIRSTROW = 1,
        TABLOCK,
        CODEPAGE = '65001'
      )
    `);
  } finally {
    await pool.request().query(`IF EXISTS (SELECT * FROM sys.external_data_sources WHERE name='${tempDs}') DROP EXTERNAL DATA SOURCE [${tempDs}]`).catch(() => {});
    await pool.request().query(`IF EXISTS (SELECT * FROM sys.database_scoped_credentials WHERE name='${tempCred}') DROP DATABASE SCOPED CREDENTIAL [${tempCred}]`).catch(() => {});
    await blockClient.delete().catch(() => {});
  }

  return total;
}
