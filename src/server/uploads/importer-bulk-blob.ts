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
import { normalizeDateLike } from "./date-normalize";
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

/** Sanitize a single value for NVARCHAR bulk-insert CSV output.
 *  Escapes double-quotes, replaces control characters with space,
 *  and wraps in double-quotes. Returns '""' for null/empty. */
export function sanitizeCsvField(v: unknown): string {
  if (v == null || String(v).trim() === "") return '""';
  const sanitized = String(v)
    .replace(/"/g, '""')
    .replace(/[\n\r\t]/g, " ")
    .replace(/\|/g, " ");
  return '"' + sanitized + '"';
}

/**
 * Emit a CSV field already converted to the target SQL type.
 * Numeric/date types are written unquoted (SQL Server parses them natively during BULK INSERT);
 * empty/invalid values are written as empty (= NULL via KEEPNULLS).
 * NVARCHAR falls through to sanitizeCsvField.
 *
 * The _cw_rh row hash is always computed from sanitizeCsvField output (backward-compatible),
 * NOT from this function — so delta-replace hash comparisons stay correct across deploys.
 */
export function typedCsvField(v: unknown, sqlType: string): string {
  const raw = v == null ? "" : String(v).trim();
  if (!raw) return ""; // unquoted empty → NULL via KEEPNULLS for all types

  if (sqlType === "BIGINT") {
    // Only accept pure integers — mirrors TRY_CONVERT(BIGINT) which rejects thousands-separator formats
    if (!/^-?\d+$/.test(raw)) return "";
    return raw;
  }
  if (sqlType.startsWith("DECIMAL")) {
    // BR format: "1.234,56" → "1234.5600"
    const s = raw.includes(",") ? raw.replaceAll(".", "").replace(",", ".") : raw;
    const n = Number.parseFloat(s);
    return isNaN(n) ? "" : n.toFixed(4);
  }
  if (sqlType === "DATE") {
    const d = normalizeDateLike(raw);
    return d ? d.slice(0, 10) : ""; // YYYY-MM-DD
  }
  if (sqlType === "DATETIME2") {
    const d = normalizeDateLike(raw);
    return d ? d.replace("T", " ").replace("Z", "").slice(0, 23) : "";
  }
  if (sqlType === "TIME") {
    return /^\d{1,2}:\d{2}(:\d{2})?$/.test(raw) ? raw : "";
  }
  return sanitizeCsvField(v);
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
  const cleanBlobName = `bulkimport/${uploadId}.csv`;
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

  let total = 0;
  const reusedCleanBlob = false;

  await mark("convertUploadCleanBlobMs", async () => {
    if (await blockClient.exists()) {
      await blockClient.delete().catch(() => {});
    }

    const passThrough = new PassThrough({ highWaterMark: 65536 });
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
        // Hash uses sanitizeCsvField (stable across deploys — hash must match existing target rows)
        const hashLine = mapping.map(c => sanitizeCsvField(row[c.sqlName])).join("|");
        const rowHash  = createHash("md5").update(hashLine).digest("hex");
        // CSV content uses pre-converted types so BULK INSERT writes to typed staging columns
        // without any TRY_CONVERT work on Azure SQL (shifts CPU from DTU-limited SQL to Node.js)
        const csvLine = mapping.map(c => typedCsvField(row[c.sqlName], c.sqlType)).join("|");
        passThrough.write(csvLine + "|" + rowHash + "\n");
        total++;
        if (total % 50_000 === 0) onProgress?.(total);
      }
    }

    passThrough.end();
    await uploadPromise;
  });

  const credential = new StorageSharedKeyCredential(account, key);

  const pool = await sqlPool();
  const hash = createHash("md5").update(uploadId).digest("hex").slice(0, 8);
  const tempCred = `CatworldBulkCred_${hash}`;
  const tempDs = `CatworldBulkDS_${hash}`;
  let bulkAttempts = 0;

  // CREATE credential/DS on first attempt; ALTER credential on retry (DS already exists).
  // Avoids DROP+CREATE DDL on the critical path — 2 DDL ops on first attempt vs 1 ALTER on retry.
  // Cleanup (DROP) still happens in the finally block after all attempts complete.
  async function ensureCredentialAndDataSource(sas: string) {
    await pool.request().query(`
      IF NOT EXISTS (SELECT 1 FROM sys.database_scoped_credentials WHERE name='${tempCred}')
        CREATE DATABASE SCOPED CREDENTIAL [${tempCred}]
          WITH IDENTITY = 'SHARED ACCESS SIGNATURE', SECRET = '${sas}';
      ELSE
        ALTER DATABASE SCOPED CREDENTIAL [${tempCred}]
          WITH IDENTITY = 'SHARED ACCESS SIGNATURE', SECRET = '${sas}';
      IF NOT EXISTS (SELECT 1 FROM sys.external_data_sources WHERE name='${tempDs}')
        CREATE EXTERNAL DATA SOURCE [${tempDs}]
          WITH (TYPE = BLOB_STORAGE, LOCATION = 'https://${account}.blob.core.windows.net/${container}', CREDENTIAL = [${tempCred}]);
    `);
  }

  try {
    const bulkReq = pool.request();
    (bulkReq as unknown as { overrides: { requestTimeout: number } }).overrides.requestTimeout = 30 * 60_000;
    const bulkSql = `
      BULK INSERT ${quoteIdentifier(schema)}.${quoteIdentifier(stagingTable)}
      FROM '${cleanBlobName}'
      WITH (
        DATA_SOURCE = '${tempDs}',
        FORMAT = 'CSV',
        FIELDTERMINATOR = '|',
        ROWTERMINATOR = '\n',
        FIELDQUOTE = '"',
        FIRSTROW = 1,
        KEEPNULLS,
        TABLOCK,
        CODEPAGE = '65001',
        ROWS_PER_BATCH = 50000
      )
    `;

    for (let attempt = 1; ; attempt++) {
      bulkAttempts = attempt;
      try {
        // Truncate staging on retry (was partially loaded on previous attempt)
        if (attempt > 1) {
          await pool.request().query(`TRUNCATE TABLE ${quoteIdentifier(schema)}.${quoteIdentifier(stagingTable)}`);
        }

        // Fresh SAS token + atomic DROP+CREATE per attempt
        const sas = generateBlobSASQueryParameters(
          { containerName: container, blobName: cleanBlobName, permissions: BlobSASPermissions.parse("r"), expiresOn: new Date(Date.now() + 60 * 60_000) },
          credential
        ).toString();

        await ensureCredentialAndDataSource(sas);
        await mark("bulkInsertMs", () => bulkReq.query(bulkSql));
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        let detail = message;

        if (error && typeof error === "object" && "precedingErrors" in error) {
          const preceding = (error as { precedingErrors: unknown[] }).precedingErrors;
          if (preceding && preceding.length > 0) {
            detail += " | precedingErrors: " + preceding.map(e => e instanceof Error ? e.message : String(e)).join("; ");
          }
        }

        if (error instanceof Error && "number" in error) {
          detail += ` | sqlNumber=${(error as Error & { number: number }).number}`;
        }

        if (attempt >= 5 || !message.includes('OLE DB provider "BULK"')) {
          const enhanced = new Error(detail);
          enhanced.stack = (error instanceof Error ? error.stack : undefined);
          throw enhanced;
        }
        const waitMs = 5_000 * attempt;
        console.warn(`[bulkInsert] transient BULK provider error, retry ${attempt}/5 in ${waitMs}ms: ${detail}`);
        await mark("bulkRetryWaitMs", () => new Promise(r => setTimeout(r, waitMs)));
      }
    }
  } finally {
    // Cleanup: drop data source first (depends on credential), then credential
    await pool.request().query(`DROP EXTERNAL DATA SOURCE IF EXISTS [${tempDs}]`).catch(() => {});
    await pool.request().query(`DROP DATABASE SCOPED CREDENTIAL IF EXISTS [${tempCred}]`).catch(() => {});
  }

  return { total, timings, cleanBlobName, reusedCleanBlob, bulkAttempts };
}

/**
 * Write clean blob then INSERT directly into target via OPENROWSET.
 * Eliminates the staging table entirely for full-replace operations —
 * one log write pass instead of two (BULK INSERT staging + INSERT SELECT target).
 */
export async function openrowsetInsertFromBlob(
  uploadId: string,
  source: string | NodeJS.ReadableStream,
  mapping: ParsedColumn[],
  schema: string,
  targetTable: string,
  opts?: RowsFromFileOpts,
  onProgress?: (rows: number) => void,
): Promise<BulkBlobResult> {
  const { connStr, account, key, container } = blobEnv();
  const cleanBlobName = `bulkimport/${uploadId}.csv`;
  const timings: Record<string, number> = {};
  const mark = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    try { return await fn(); }
    finally { timings[name] = (timings[name] ?? 0) + Date.now() - started; }
  };

  const service = BlobServiceClient.fromConnectionString(connStr);
  const blockClient = service.getContainerClient(container).getBlockBlobClient(cleanBlobName);

  let total = 0;

  // Write clean blob (same format as bulkInsertFromBlob: typed values + hash column)
  await mark("convertUploadCleanBlobMs", async () => {
    if (await blockClient.exists()) await blockClient.delete().catch(() => {});
    const passThrough = new PassThrough({ highWaterMark: 65536 });
    const uploadPromise = blockClient.uploadStream(passThrough, 8 * 1024 * 1024, 4, {
      blobHTTPHeaders: { blobContentType: "text/csv; charset=utf-8" },
    });
    for await (const row of rowsFromFile(source, mapping, opts)) {
      const hashLine = mapping.map(c => sanitizeCsvField(row[c.sqlName])).join("|");
      const rowHash  = createHash("md5").update(hashLine).digest("hex");
      const csvLine  = mapping.map(c => typedCsvField(row[c.sqlName], c.sqlType)).join("|");
      passThrough.write(csvLine + "|" + rowHash + "\n");
      total++;
      if (total % 50_000 === 0) onProgress?.(total);
    }
    passThrough.end();
    await uploadPromise;
  });

  const credential = new StorageSharedKeyCredential(account, key);
  const pool = await sqlPool();
  const hash = createHash("md5").update(uploadId).digest("hex").slice(0, 8);
  const tempCred = `CatworldBulkCred_${hash}`;
  const tempDs   = `CatworldBulkDS_${hash}`;

  // WITH clause: typed columns matching typedCsvField output.
  // NVARCHAR uses MAX (target column is NVARCHAR(MAX)) to avoid truncation.
  const withCols = [
    ...mapping.map(c => {
      const t = c.sqlType === "BIGINT" ? "BIGINT"
        : c.sqlType.startsWith("DECIMAL") ? "DECIMAL(18,4)"
        : c.sqlType === "DATE" ? "DATE"
        : c.sqlType === "DATETIME2" ? "DATETIME2"
        : c.sqlType === "TIME" ? "TIME"
        : "NVARCHAR(MAX)";
      return `${quoteIdentifier(c.sqlName)} ${t} NULL`;
    }),
    `[_cw_rh] CHAR(32) NULL`,
  ].join(",\n    ");
  const colList = [...mapping.map(c => quoteIdentifier(c.sqlName)), "[_cw_rh]"].join(",");

  async function ensureCredentialAndDataSource(sas: string) {
    await pool.request().query(`
      IF NOT EXISTS (SELECT 1 FROM sys.database_scoped_credentials WHERE name='${tempCred}')
        CREATE DATABASE SCOPED CREDENTIAL [${tempCred}]
          WITH IDENTITY = 'SHARED ACCESS SIGNATURE', SECRET = '${sas}';
      ELSE
        ALTER DATABASE SCOPED CREDENTIAL [${tempCred}]
          WITH IDENTITY = 'SHARED ACCESS SIGNATURE', SECRET = '${sas}';
      IF NOT EXISTS (SELECT 1 FROM sys.external_data_sources WHERE name='${tempDs}')
        CREATE EXTERNAL DATA SOURCE [${tempDs}]
          WITH (TYPE = BLOB_STORAGE, LOCATION = 'https://${account}.blob.core.windows.net/${container}', CREDENTIAL = [${tempCred}]);
    `);
  }

  const insertSql = `
    INSERT INTO ${quoteIdentifier(schema)}.${quoteIdentifier(targetTable)} WITH (TABLOCK) (${colList})
    SELECT ${colList}
    FROM OPENROWSET(
      BULK '${cleanBlobName}',
      DATA_SOURCE = '${tempDs}',
      FORMAT = 'CSV',
      FIELDTERMINATOR = '|',
      ROWTERMINATOR = '\\n',
      FIELDQUOTE = '"',
      FIRSTROW = 1,
      KEEPNULLS
    ) WITH (
      ${withCols}
    ) AS t
    OPTION (MAXDOP 1)
  `;

  let bulkAttempts = 0;
  try {
    for (let attempt = 1; ; attempt++) {
      bulkAttempts = attempt;
      try {
        if (attempt > 1) {
          await pool.request().query(
            `TRUNCATE TABLE ${quoteIdentifier(schema)}.${quoteIdentifier(targetTable)}`
          );
        }
        const sas = generateBlobSASQueryParameters(
          { containerName: container, blobName: cleanBlobName, permissions: BlobSASPermissions.parse("r"), expiresOn: new Date(Date.now() + 60 * 60_000) },
          credential
        ).toString();
        await ensureCredentialAndDataSource(sas);
        const req = pool.request();
        (req as unknown as { overrides: { requestTimeout: number } }).overrides.requestTimeout = 30 * 60_000;
        await mark("openrowsetInsertMs", () => req.query(insertSql));
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt >= 5 || !message.includes('OLE DB provider "BULK"')) throw error;
        const waitMs = 5_000 * attempt;
        console.warn(`[openrowsetInsert] transient error, retry ${attempt}/5 in ${waitMs}ms`);
        await mark("openrowsetRetryWaitMs", () => new Promise(r => setTimeout(r, waitMs)));
      }
    }
  } finally {
    await pool.request().query(`DROP EXTERNAL DATA SOURCE IF EXISTS [${tempDs}]`).catch(() => {});
    await pool.request().query(`DROP DATABASE SCOPED CREDENTIAL IF EXISTS [${tempCred}]`).catch(() => {});
  }

  return { total, timings, cleanBlobName, reusedCleanBlob: false, bulkAttempts };
}
