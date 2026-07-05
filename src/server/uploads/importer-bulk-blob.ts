import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import {
  BlobSASPermissions,
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
} from "@azure/storage-blob";
import { sqlPool } from "@/server/azure/sql";
import { quoteIdentifier } from "@/server/security/naming";
import { rowsFromFile, type ParsedColumn, type RowsFromFileOpts } from "./parser";
import { env } from "@/server/env";

export type BulkBlobResult = {
  total: number;
  timings: Record<string, number>;
  cleanBlobName: string;
  reusedCleanBlob: boolean;
  bulkAttempts: number;
};

function blobEnv() {
  const e = env();
  const connStr = e.CATWORLD_AZURE_BLOB_CONNECTION_STRING!;
  const accountMatch = connStr.match(/AccountName=([^;]+)/i)!;
  const keyMatch = connStr.match(/AccountKey=([^;]+)/i)!;
  return { connStr, account: accountMatch[1]!, key: keyMatch[1]!, container: e.CATWORLD_AZURE_BLOB_CONTAINER };
}

function makeCleanConverter(type: string): (v: unknown) => string {
  if (type === "BIGINT") return v => (v == null || String(v).trim() === "") ? "" : String(v).trim();
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
  if (type === "TIME") return v => (v == null || String(v).trim() === "") ? "" : String(v).trim();
  return v => {
    if (v == null || String(v).trim() === "") return '""';
    return '"' + String(v).replace(/"/g, '""') + '"';
  };
}

export async function bulkInsertFromBlob(
  uploadId: string,
  source: string | NodeJS.ReadableStream,
  mapping: ParsedColumn[],
  schema: string,
  stagingTable: string,
  opts?: RowsFromFileOpts,
  onProgress?: (rows: number) => void,
  isPreProcessed = false,
  knownRowCount = 0
): Promise<BulkBlobResult> {
  const { connStr, account, key, container } = blobEnv();
  const cleanBlobName = `tmp/bulk-${uploadId}.csv`;
  const timings: Record<string, number> = {};
  const mark = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    try {
      return await fn();
    } finally {
      timings[name] = (timings[name] ?? 0) + Date.now() - started;
    }
  };

  const service = BlobServiceClient.fromConnectionString(connStr);
  const blockClient = service.getContainerClient(container).getBlockBlobClient(cleanBlobName);
  const converters = mapping.map(c => makeCleanConverter(c.sqlType));

  let total = 0;
  const reusedCleanBlob = await mark("cleanBlobExistsMs", () => blockClient.exists());
  if (reusedCleanBlob) {
    total = knownRowCount;
  } else {
    await mark("convertUploadCleanBlobMs", async () => {
      const passThrough = new PassThrough();
      const uploadPromise = blockClient.uploadStream(passThrough, 8 * 1024 * 1024, 4, {
        blobHTTPHeaders: { blobContentType: "text/csv; charset=utf-8" },
      });

      if (isPreProcessed) {
        let remainder = "";
        for await (const chunk of source as NodeJS.ReadableStream) {
          const text = remainder + (chunk as Buffer).toString("utf8");
          const lines = text.split("\n");
          remainder = lines.pop() ?? "";
          for (const line of lines) {
            if (line) {
              passThrough.write(line + "\n");
              total++;
              if (total % 50_000 === 0) onProgress?.(total);
            }
          }
        }
        if (remainder.trim()) {
          passThrough.write(remainder + "\n");
          total++;
        }
      } else {
        for await (const row of rowsFromFile(source, mapping, opts)) {
          const converted = converters.map((fn, i) => fn(row[mapping[i]!.sqlName]));
          const csvLine = converted.join("|");
          const rowHash = createHash("md5").update(csvLine).digest("hex");
          passThrough.write(csvLine + "|" + rowHash + "\n");
          total++;
          if (total % 50_000 === 0) onProgress?.(total);
        }
      }

      passThrough.end();
      await uploadPromise;
    });
  }

  await mark("blobConsistencyWaitMs", () => new Promise(r => setTimeout(r, 3000)));

  const credential = new StorageSharedKeyCredential(account, key);
  const sas = generateBlobSASQueryParameters(
    { containerName: container, blobName: cleanBlobName, permissions: BlobSASPermissions.parse("r"), expiresOn: new Date(Date.now() + 30 * 60_000) },
    credential
  ).toString();

  const pool = await sqlPool();
  const hash = createHash("md5").update(uploadId).digest("hex").slice(0, 8);
  const tempCred = `CatworldBulkCred_${hash}`;
  const tempDs = `CatworldBulkDS_${hash}`;
  let bulkAttempts = 0;
  let keepCleanBlobForRetry = false;

  try {
    await mark("createScopedCredentialMs", () => pool.request().query(`
      CREATE DATABASE SCOPED CREDENTIAL [${tempCred}]
      WITH IDENTITY = 'SHARED ACCESS SIGNATURE', SECRET = '${sas}'
    `));
    await mark("createExternalDataSourceMs", () => pool.request().query(`
      CREATE EXTERNAL DATA SOURCE [${tempDs}]
      WITH (TYPE = BLOB_STORAGE, LOCATION = 'https://${account}.blob.core.windows.net', CREDENTIAL = [${tempCred}])
    `));

    const bulkReq = pool.request();
    (bulkReq as unknown as { timeout: number }).timeout = 30 * 60_000;
    const bulkSql = `
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
    `;

    for (let attempt = 1; ; attempt++) {
      bulkAttempts = attempt;
      try {
        await mark("bulkInsertMs", () => bulkReq.query(bulkSql));
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt >= 5 || !message.includes('OLE DB provider "BULK"')) {
          keepCleanBlobForRetry = message.includes('OLE DB provider "BULK"');
          throw error;
        }
        const waitMs = 5_000 * attempt;
        console.warn(`[bulkInsert] transient BULK provider error, retry ${attempt}/5 in ${waitMs}ms: ${message}`);
        await mark("bulkRetryWaitMs", () => new Promise(r => setTimeout(r, waitMs)));
      }
    }
  } finally {
    await pool.request().query(`IF EXISTS (SELECT * FROM sys.external_data_sources WHERE name='${tempDs}') DROP EXTERNAL DATA SOURCE [${tempDs}]`).catch(() => {});
    await pool.request().query(`IF EXISTS (SELECT * FROM sys.database_scoped_credentials WHERE name='${tempCred}') DROP DATABASE SCOPED CREDENTIAL [${tempCred}]`).catch(() => {});
    if (!keepCleanBlobForRetry) await blockClient.delete().catch(() => {});
  }

  return { total, timings, cleanBlobName, reusedCleanBlob, bulkAttempts };
}
