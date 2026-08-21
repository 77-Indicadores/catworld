import * as Sentry from "@sentry/nextjs";
import { extname } from "node:path";
import sql from "mssql";
import { prisma } from "@/server/db";
import { sqlPool } from "@/server/azure/sql";
import { getStoragePool } from "@/server/storage/pool";
import { getStorageConnection } from "@/server/storage/connection";
import { quoteIdentifier, sqlIdentifier } from "@/server/security/naming";
import { previewFile, rowsFromFile, type FilePreview, type ParsedColumn, type RowsFromFileOpts, type ParseStats } from "./parser";
import { bulkInsertFromBlob, sanitizeCsvField } from "./importer-bulk-blob";
import { env } from "@/server/env";
import { normalizeDateLike } from "./date-normalize";

const SMALL_CSV_TDS_THRESHOLD_BYTES = 1 * 1024 * 1024;

function sqlTypeDef(type: string): string {
  if (type === "BIGINT") return "BIGINT";
  if (type.startsWith("DECIMAL")) return "DECIMAL(18,4)";
  if (type === "DATE") return "DATE";
  if (type === "DATETIME2") return "DATETIME2";
  if (type === "TIME") return "TIME";
  return "NVARCHAR(MAX)";
}

function typedColumnDefs(mapping: ParsedColumn[]): string {
  return mapping.map(c => `${quoteIdentifier(c.sqlName)} ${sqlTypeDef(c.sqlType)} NULL`).join(",");
}

function cleanedRef(column: ParsedColumn, alias: string): string {
  return `NULLIF(LTRIM(RTRIM(${alias}.${quoteIdentifier(column.sqlName)})),'')`;
}

function typedSelectExpr(column: ParsedColumn, alias: string): string {
  const value = cleanedRef(column, alias);
  if (column.sqlType === "BIGINT") return `TRY_CONVERT(BIGINT,${value})`;
  if (column.sqlType.startsWith("DECIMAL")) {
    return `TRY_CONVERT(DECIMAL(18,4),CASE WHEN ${value} LIKE '%,%' THEN REPLACE(REPLACE(${value},'.',''),',','.') ELSE ${value} END)`;
  }
  if (column.sqlType === "DATE") {
    return `COALESCE(TRY_CONVERT(DATE,${value},23),TRY_CONVERT(DATE,${value},126),TRY_CONVERT(DATE,${value},103),TRY_CONVERT(DATE,${value},101))`;
  }
  if (column.sqlType === "DATETIME2") {
    return `COALESCE(TRY_CONVERT(DATETIME2,${value},126),TRY_CONVERT(DATETIME2,${value},120),TRY_CONVERT(DATETIME2,${value},103),TRY_CONVERT(DATETIME2,${value},101))`;
  }
  if (column.sqlType === "TIME") return `TRY_CONVERT(TIME,${value})`;
  return `${alias}.${quoteIdentifier(column.sqlName)}`;
}

// ─── Typed staging helpers ────────────────────────────────────────────────────

/** SQL type for the staging table column — mirrors typedCsvField in importer-bulk-blob.ts */
function stagingColType(sqlType: string): string {
  if (sqlType === "BIGINT") return "BIGINT";
  if (sqlType.startsWith("DECIMAL")) return "DECIMAL(18,4)";
  if (sqlType === "DATE") return "DATE";
  if (sqlType === "DATETIME2") return "DATETIME2";
  if (sqlType === "TIME") return "TIME";
  if (sqlType === "NVARCHAR(MAX)") return "NVARCHAR(MAX)";
  return "NVARCHAR(4000)";
}

/** mssql column type for TDS bulk copy into a typed staging table */
function tdsColType(sqlType: string): sql.ISqlType | (() => sql.ISqlType) {
  if (sqlType === "BIGINT") return sql.BigInt;
  if (sqlType.startsWith("DECIMAL")) return sql.Decimal(18, 4);
  if (sqlType === "DATE") return sql.Date;
  if (sqlType === "DATETIME2") return sql.DateTime2;
  if (sqlType === "TIME") return sql.Time;
  if (sqlType === "NVARCHAR(MAX)") return sql.NVarChar(sql.MAX);
  return sql.NVarChar(4000);
}

/** Convert a raw string value to a JS value suitable for TDS into a typed staging column. */
function convertForTds(v: unknown, sqlType: string): unknown {
  const s = v == null ? "" : String(v).trim();
  if (!s) return null;
  if (sqlType === "BIGINT") {
    if (!/^-?\d+$/.test(s)) return null;
    try {
      const b = BigInt(s);
      // SQL Server BIGINT is signed 64-bit: -(2^63) to 2^63-1
      if (b < 0n || b > 9223372036854775807n) return null; // tedious BigInt handler requires >= 0n
      return Number(b);
    } catch { return null; }
  }
  if (sqlType.startsWith("DECIMAL")) {
    const lastDot = s.lastIndexOf(".");
    const lastComma = s.lastIndexOf(",");
    const cleaned = lastComma > lastDot
      ? s.replaceAll(".", "").replace(",", ".") // BR: "1.234,56"
      : s.replaceAll(",", "");                  // US/neutral: "1,234.56"
    const n = Number.parseFloat(cleaned);
    // DECIMAL(18,4) max integer part is 14 digits; reject larger values
    if (!Number.isFinite(n) || Math.abs(n) >= 1e14) return null;
    return n;
  }
  if (sqlType === "DATE" || sqlType === "DATETIME2") {
    const d = normalizeDateLike(s);
    if (!d) return null;
    // Ensure proper ISO 8601: space→T, truncate fractional seconds to 3 digits
    // (SQL Server exports "2023-01-15 08:30:00.0000000" which V8 may reject)
    const iso = d.replace(" ", "T").replace(/(\.\d{3})\d+/, "$1");
    const date = new Date(iso);
    return isNaN(date.getTime()) ? null : date;
  }
  if (sqlType === "TIME") {
    // mssql sql.Time requires a Date object — passing a string throws "Invalid time."
    if (!/^\d{1,2}:\d{2}(:\d{2})?(\.\d+)?$/.test(s)) return null;
    const [hh, mm, ss = "0"] = s.split(":");
    const [sec, frac = "0"] = ss.split(".");
    const h = Number(hh), m = Number(mm), se = Number(sec), ms = Math.round(Number("0." + frac) * 1000);
    if (h > 23 || m > 59 || se > 59) return null;
    const d = new Date(1970, 0, 1, h, m, se, ms);
    return isNaN(d.getTime()) ? null : d;
  }
  // Strip null bytes — they can corrupt the TDS BCP stream (error 4815)
  return s.replace(/\x00/g, "") || null;
}

// ─── TDS bulk copy ────────────────────────────────────────────────────────────
// Used as the primary path for small CSVs/XLS and as automatic fallback when
// BULK INSERT fails with an OLE DB provider error.
async function tdsBulkCopy(
  pool: sql.ConnectionPool,
  source: string | NodeJS.ReadableStream,
  mapping: ParsedColumn[],
  schema: string,
  destTable: string,
  opts: RowsFromFileOpts,
  knownRowCount: number,
  uploadId: string,
  onProgress?: (rows: number) => void,
  typed = true,
  stats?: ParseStats,
): Promise<number> {
  const batchDelay = env().CATWORLD_IMPORT_BATCH_DELAY_MS;
  const stringify = (v: unknown) => (v == null || String(v).trim() === "" ? null : String(v));

  let batch: Record<string, unknown>[] = [];
  let total = 0;

  const flush = async () => {
    if (!batch.length) return;
    const bulk = new sql.Table(`${schema}.${destTable}`);
    bulk.create = false;
    for (const c of mapping) {
      bulk.columns.add(c.sqlName, typed ? tdsColType(c.sqlType) : sql.NVarChar(sql.MAX), { nullable: true });
    }
    bulk.columns.add("_cw_rh", sql.Char(32), { nullable: true });
    const { createHash: ch } = await import("node:crypto");
    for (const row of batch) {
      const vals = typed
        ? mapping.map(c => convertForTds(row[c.sqlName], c.sqlType))
        : mapping.map(c => stringify(row[c.sqlName]));
      const rh = ch("md5").update(mapping.map(c => sanitizeCsvField(row[c.sqlName])).join("|")).digest("hex");
      vals.push(rh);
      bulk.rows.add(...(vals as Parameters<typeof bulk.rows.add>));
    }
    const bulkReq = new sql.Request(pool);
    (bulkReq as unknown as { overrides: { requestTimeout: number } }).overrides.requestTimeout = 7_200_000;
    await bulkReq.bulk(bulk, { tableLock: true });
    total += batch.length;
    batch = [];
    if (batchDelay > 0) await new Promise(r => setTimeout(r, batchDelay));
    onProgress?.(total);
  };

  for await (const row of rowsFromFile(source, mapping, opts, stats)) {
    batch.push(row);
    if (batch.length >= 50_000) await flush();
  }
  await flush();

  console.log("[tdsBulkCopy] upload=%s rows=%d", uploadId, total);
  return total;
}

// ─── Main import entry point ───────────────────────────────────────────────────
export async function importUpload(uploadId: string, source: string | NodeJS.ReadableStream) {
  // Roteamento por provider: PG usa importer dedicado, mssql usa o caminho abaixo
  const upload0 = await prisma.upload.findUniqueOrThrow({
    where: { id: uploadId },
    include: { dataset: { select: { storageServerId: true } } },
  });
  const conn0 = await getStorageConnection(upload0.dataset?.storageServerId ?? null);
  if (conn0.provider === "postgres") {
    const { importUploadPg } = await import("./importer-pg");
    const { PgStorageConnection } = await import("@/server/storage/pg-storage");
    return importUploadPg(uploadId, source, conn0 as InstanceType<typeof PgStorageConnection>);
  }
  // ─── SQL Server path (código original abaixo) ─────────────────────────────────

  const importStarted = Date.now();
  const phaseTimings: Record<string, unknown> = {};
  const parseStats: ParseStats = {};

  const upload = await prisma.upload.findUniqueOrThrow({ where: { id: uploadId }, include: { dataset: true, table: true } });
  if (!upload.dataset) throw new Error("Dataset não definido");

  const mapping = (upload.mappingJson
    ? JSON.parse(upload.mappingJson)
    : (await previewFile(source as string)).columns) as ParsedColumn[];
  const knownRowCount = Number(upload.rowCount ?? 0);

  if (!mapping.length) throw new Error("Nenhuma coluna mapeada — verifique o mapeamento do arquivo");

  const tableName = upload.table?.sqlName ?? sqlIdentifier(upload.originalFilename.replace(/\.[^.]+$/, ""));
  const schema = upload.dataset.schemaName;
  const stage = `cw_stage_${upload.id.replaceAll("-", "").slice(0, 20)}`;
  const pool = await getStoragePool(upload.dataset.storageServerId);
  const target = `${quoteIdentifier(schema)}.${quoteIdentifier(tableName)}`;
  const staging = `${quoteIdentifier(schema)}.${quoteIdentifier(stage)}`;

  // Typed staging: Node.js pre-converts values (typedCsvField) so BULK INSERT writes native types
  // and the delta INSERT SELECT becomes a direct column copy — no TRY_CONVERT on Azure SQL (saves DTU).
  // colDefsMax is kept as fallback when a NVARCHAR value exceeds 4000 chars (rare truncation error).
  const colDefs    = mapping.map(c => `${quoteIdentifier(c.sqlName)} ${stagingColType(c.sqlType)} NULL`).join(",") + ",[_cw_rh] CHAR(32) NULL";
  const colDefsMax = mapping.map(c => `${quoteIdentifier(c.sqlName)} NVARCHAR(MAX)  NULL`).join(",") + ",[_cw_rh] CHAR(32) NULL";
  // Set to false if truncation forces NVARCHAR(MAX) fallback — INSERT SELECT must use TRY_CONVERT then
  let stagingIsTyped = true;

  const targetExists = Number(
    (await pool.request().query(`SELECT CASE WHEN OBJECT_ID(N'${schema}.${tableName}',N'U') IS NULL THEN 0 ELSE 1 END AS ok`))
      .recordset[0].ok,
  ) === 1;

  // Validate schema compatibility BEFORE creating staging — fail fast on bad append/upsert
  if ((upload.mode === "append" || upload.mode === "upsert") && targetExists) {
    await assertCompatible(pool.request(), schema, tableName, mapping);
  }

  const hasDeltaCol = targetExists && await checkHasDeltaCol(pool, schema, tableName);
  const schemaOk = targetExists && await schemaMatchesSilent(pool, schema, tableName, mapping);
  const deltaReplace = upload.mode === "replace" && hasDeltaCol && schemaOk;
  // Phase 2: SDK pre-computed delta — deltaJson holds JSON array of hashes to delete
  const phase2 = deltaReplace && upload.deltaJson != null;
  const toDelete: string[] = phase2 ? (JSON.parse(upload.deltaJson!) as string[]) : [];

  // Detect OPENROWSET opportunity BEFORE staging creation.
  // Full replace + blob available + no delta: INSERT directly into target via OPENROWSET,
  // skipping the staging table entirely (50% fewer log writes — one pass vs two).
  const ext = extname(upload.originalFilename).toLowerCase();
  const smallCsv = !phase2 && ext === ".csv" && Number(upload.sizeBytes) <= SMALL_CSV_TDS_THRESHOLD_BYTES;
  const useBlob = !!env().CATWORLD_AZURE_BLOB_CONNECTION_STRING && !smallCsv;
  const canUseOpenrowset = useBlob && !phase2 && !deltaReplace && (upload.mode === "replace" || !targetExists);

  // ── Idempotency: if staging already exists and has rows, skip data loading ──
  // This handles retries where the staging was populated but the transaction failed.
  // BUG2-fix: if staging row count < knownRowCount (for full replace), it means the staging is
  // incomplete from a mid-stream crash — drop it and re-import from scratch. Trusting a partial
  // staging would mark the upload COMPLETED with fewer rows than the file actually contains.
  const stagingRowCount = await checkStagingHasData(pool, schema, stage);
  const isFullReplaceMode = (upload.mode === "replace" || !targetExists) && !deltaReplace && !phase2;
  const stagingIsPartial = stagingRowCount > 0 && isFullReplaceMode && knownRowCount > 0 && stagingRowCount < knownRowCount;

  if (stagingIsPartial) {
    console.warn("[importUpload] staging parcial detectado (%d/%d linhas) — descartando e reimportando upload=%s", stagingRowCount, knownRowCount, uploadId);
    await pool.request().query(`DROP TABLE ${staging}`).catch(() => {});
  }

  const stagingHasData = !stagingIsPartial && stagingRowCount > 0;

  if (!stagingHasData && !canUseOpenrowset) {
    await pool.request().query(
      `IF OBJECT_ID(N'${schema}.${stage}',N'U') IS NOT NULL DROP TABLE ${staging};
       CREATE TABLE ${staging} (${colDefs})`,
    );
  } else if (stagingHasData) {
    console.log("[importUpload] staging já populado (%d linhas), pulando carga (retry idempotente) upload=%s", stagingRowCount, uploadId);
  }

  let total = 0, inserted = 0, updated = 0;
  let lastProgressMs = Date.now();
  let deleteCleanBlob: (() => Promise<void>) | undefined;
  let actual = 0n;

  try {
    const preview = upload.previewJson ? JSON.parse(upload.previewJson) as FilePreview : null;
    const opts: RowsFromFileOpts = { encoding: preview?.encoding ?? "utf8", separator: preview?.separator ?? ",", ext };

    const onProgress = (n: number) => {
      const now = Date.now();
      if (now - lastProgressMs > 10_000) {
        void prisma.upload.update({
          where: { id: upload.id },
          data: { progress: Math.min(75, 35 + Math.floor(n / Math.max(knownRowCount, 1) * 40)) },
        });
        lastProgressMs = now;
      }
    };

    if (canUseOpenrowset) {
      // ── Direct BULK INSERT → temp table → atomic rename to target ─────────────
      // SAFETY: BULK INSERT into a temp table first; only rename to production after
      // verifying row count. This preserves old data if BULK INSERT fails mid-stream.
      const cleanBlobName = `bulkimport/${uploadId}.csv`;
      await deleteBulkCleanBlob(cleanBlobName);

      // Temp table lives in the same schema, named by uploadId (idempotent across retries).
      const directTmp = `cw_direct_${upload.id.replaceAll("-", "").slice(0, 20)}`;
      const directTmpFull = `${quoteIdentifier(schema)}.${quoteIdentifier(directTmp)}`;

      // Drop any leftover temp from a previous failed attempt, then create fresh.
      await pool.request().query(
        `IF OBJECT_ID(N'${schema}.${directTmp}',N'U') IS NOT NULL DROP TABLE ${directTmpFull};
         CREATE TABLE ${directTmpFull} (${typedColumnDefs(mapping)},[_cw_rh] CHAR(32) NULL)`,
      );

      try {
        const orResult = await bulkInsertFromBlob(
          uploadId, source, mapping, schema, directTmp, opts, onProgress, false, knownRowCount, parseStats, pool,
        );
        total = orResult.total;
        inserted = total;
        phaseTimings.importMethod = "direct-bulk";
        phaseTimings.bulkBlob = orResult;
        let cleanBlobDeleted = false;
        deleteCleanBlob = async () => {
          if (cleanBlobDeleted || !env().CATWORLD_AZURE_BLOB_CONNECTION_STRING) return;
          cleanBlobDeleted = true;
          const { BlobServiceClient } = await import("@azure/storage-blob");
          const { env: getEnv } = await import("@/server/env");
          const eBlob = getEnv();
          BlobServiceClient.fromConnectionString(eBlob.CATWORLD_AZURE_BLOB_CONNECTION_STRING!)
            .getContainerClient(eBlob.CATWORLD_AZURE_BLOB_CONTAINER)
            .getBlockBlobClient(orResult.cleanBlobName).delete().catch(() => {});
        };
      } catch (orError) {
        // BULK INSERT failed — clean up temp, old target is UNTOUCHED.
        await pool.request().query(
          `IF OBJECT_ID(N'${schema}.${directTmp}',N'U') IS NOT NULL DROP TABLE ${directTmpFull}`,
        ).catch(() => {});
        await deleteBulkCleanBlob(cleanBlobName);
        throw orError;
      }

      await pool.request().query(`CREATE INDEX [IX__cw_rh] ON ${directTmpFull} ([_cw_rh])`);

      // Integrity check BEFORE dropping the old target — row count must match parsed count.
      const countStr = (await pool.request().query(
        `SELECT COUNT_BIG(*) count FROM ${directTmpFull}`,
      )).recordset[0].count as string;
      actual = BigInt(countStr);

      if (actual !== BigInt(total)) {
        // Count mismatch — drop temp, old target is still intact.
        await pool.request().query(
          `IF OBJECT_ID(N'${schema}.${directTmp}',N'U') IS NOT NULL DROP TABLE ${directTmpFull}`,
        ).catch(() => {});
        throw new Error(
          `[integrity] direct-bulk: arquivo produziu ${total} linhas mas tabela temporária tem ${actual.toString()} linhas. ` +
          `Tabela original preservada. Upload marcado FAILED.`,
        );
      }

      // Count verified — swap temp → target inside an explicit transaction so a crash
      // between DROP and sp_rename rolls back and restores the old target automatically.
      const swapTx = new sql.Transaction(pool);
      await swapTx.begin();
      try {
        const swapReq = new sql.Request(swapTx);
        await swapReq.query(
          `IF OBJECT_ID(N'${schema}.${tableName}',N'U') IS NOT NULL DROP TABLE ${target}`,
        );
        await swapReq.query(`EXEC sp_rename '${schema}.${directTmp}', '${tableName}'`);
        await swapTx.commit();
      } catch (swapErr) {
        await swapTx.rollback().catch(() => undefined);
        await pool.request().query(
          `IF OBJECT_ID(N'${schema}.${directTmp}',N'U') IS NOT NULL DROP TABLE ${directTmpFull}`,
        ).catch(() => {});
        throw swapErr;
      }
    } else {
      // ── Staging path (delta replace, TDS, append, upsert, phase2) ─────────────
      const destTable = stage;

      if (!stagingHasData) {
        if (useBlob) {
          // Fast path: stream → clean blob → BULK INSERT into staging
          const cleanBlobName = `bulkimport/${uploadId}.csv`;
          try {
            const blobResult = await bulkInsertFromBlob(
              uploadId, source, mapping, schema, destTable, opts, onProgress, phase2, knownRowCount, parseStats, pool,
            );
            total = blobResult.total;
            phaseTimings.importMethod = "blob-bulk";
            phaseTimings.bulkBlob = blobResult;

            let cleanBlobDeleted = false;
            deleteCleanBlob = async () => {
              if (cleanBlobDeleted || !env().CATWORLD_AZURE_BLOB_CONNECTION_STRING) return;
              cleanBlobDeleted = true;
              const { BlobServiceClient } = await import("@azure/storage-blob");
              const { env: getEnv } = await import("@/server/env");
              const eBlob = getEnv();
              const s = BlobServiceClient.fromConnectionString(eBlob.CATWORLD_AZURE_BLOB_CONNECTION_STRING!);
              await s.getContainerClient(eBlob.CATWORLD_AZURE_BLOB_CONTAINER)
                .getBlockBlobClient(blobResult.cleanBlobName).delete().catch(() => {});
            };
          } catch (bulkError) {
            await deleteBulkCleanBlob(cleanBlobName);

            const message = bulkError instanceof Error ? bulkError.message : String(bulkError);
            const isOleDb      = message.includes('OLE DB provider "BULK"') || message.includes("blob does not exist");
            // NVARCHAR(4000) staging: if a field value exceeds 4000 chars, BULK INSERT throws
            // error 8152 ("String or binary data would be truncated") or error number 4864
            // ("type mismatch" — BULK INSERT uses 4864 for column overflow, not 8152).
            // Use error.number for 4864 (not message text, which contains row numbers that
            // can contain "4864" as a substring and produce false positives).
            const sqlErrNum = (bulkError as Error & { number?: number }).number;
            const isTruncation = message.includes("String or binary data would be truncated") || sqlErrNum === 8152 || sqlErrNum === 4864;

            if (!isOleDb && !isTruncation) throw bulkError;

            if (isTruncation) {
              Sentry.addBreadcrumb({ category: "import", level: "warning", message: "BULK INSERT truncation — rebuilding staging as NVARCHAR(MAX)", data: { uploadId } });
              phaseTimings.importMethod = "tds-fallback-after-truncation";
              stagingIsTyped = false;
              await pool.request().query(
                `IF OBJECT_ID(N'${schema}.${stage}',N'U') IS NOT NULL DROP TABLE ${staging};
                 CREATE TABLE ${staging} (${colDefsMax})`,
              ).catch(() => {});
            } else {
              Sentry.addBreadcrumb({ category: "import", level: "warning", message: "BULK INSERT failed — falling back to TDS", data: { uploadId, error: message.slice(0, 200) } });
              phaseTimings.importMethod = "tds-fallback-after-bulk-error";
            }

            await pool.request()
              .query(`IF OBJECT_ID(N'${schema}.${stage}',N'U') IS NOT NULL TRUNCATE TABLE ${staging}`)
              .catch(() => {});

            const { downloadFile } = await import("@/server/storage");
            let tdsSource: NodeJS.ReadableStream;
            try {
              tdsSource = await downloadFile(`originals/${upload.id}${ext}`);
            } catch {
              tdsSource = await downloadFile(upload.blobName);
            }

            total = await tdsBulkCopy(pool, tdsSource, mapping, schema, destTable, opts, knownRowCount, uploadId, onProgress, stagingIsTyped, parseStats);
          }
        } else {
          // TDS path: small CSV or no blob storage configured
          phaseTimings.importMethod = smallCsv ? "tds-small-csv" : "tds-primary";
          try {
            total = await tdsBulkCopy(pool, source, mapping, schema, destTable, opts, knownRowCount, uploadId, onProgress, true, parseStats);
          } catch (tdsErr) {
            const tdsMsg = tdsErr instanceof Error ? tdsErr.message : String(tdsErr);
            // 4815 = BCP protocol error (bad value mid-stream); fall back to blob-bulk if storage is available
            const isBcpErr = tdsMsg.includes("4815") || tdsMsg.toLowerCase().includes("bcp");
            if (!isBcpErr || !env().CATWORLD_AZURE_BLOB_CONNECTION_STRING) throw tdsErr;

            Sentry.addBreadcrumb({ category: "import", level: "warning", message: "TDS 4815 BCP error — falling back to blob-bulk", data: { uploadId } });
            phaseTimings.importMethod = "blob-bulk-after-tds-4815";
            await pool.request().query(`TRUNCATE TABLE ${staging}`).catch(() => {});

            const { downloadFile } = await import("@/server/storage");
            let blobSrc: NodeJS.ReadableStream;
            try { blobSrc = await downloadFile(`originals/${upload.id}${ext}`); }
            catch { blobSrc = await downloadFile(upload.blobName); }

            const blobResult = await bulkInsertFromBlob(
              uploadId, blobSrc, mapping, schema, destTable, opts, onProgress, false, knownRowCount, parseStats, pool,
            );
            total = blobResult.total;
            phaseTimings.bulkBlob = blobResult;
          }
        }
      } else {
        // Idempotent retry: staging already populated, just count what's there.
        // Detect whether staging was created as typed or NVARCHAR(MAX) (truncation fallback).
        const countRes = await pool.request().query(`SELECT COUNT_BIG(*) n FROM ${staging}`);
        total = Number(countRes.recordset[0].n);
        phaseTimings.importMethod = "idempotent-retry";
        const nonNvarcharCol = mapping.find(c => !c.sqlType.startsWith("NVARCHAR") && c.sqlType !== "TEXT");
        if (nonNvarcharCol) {
          const colTypeRes = await pool.request().query(
            `SELECT DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA='${schema}' AND TABLE_NAME='${stage}' AND COLUMN_NAME='${nonNvarcharCol.sqlName}'`,
          );
          const dt = ((colTypeRes.recordset[0]?.DATA_TYPE as string | undefined) ?? "").toUpperCase();
          stagingIsTyped = dt !== "NVARCHAR";
        }
      }

      // Index staging._cw_rh so NOT EXISTS lookups are O(n log n) instead of O(n²)
      // Large staging tables can take >10 min to index — needs explicit 2h timeout.
      if (!stagingHasData) {
        const idxReq = pool.request();
        (idxReq as unknown as { overrides: { requestTimeout: number } }).overrides.requestTimeout = 7_200_000;
        await idxReq.query(
          `IF OBJECT_ID(N'${schema}.${stage}',N'U') IS NOT NULL
             CREATE NONCLUSTERED INDEX [IX_stage_rh] ON ${staging} ([_cw_rh])`,
        );
      }
      // Ensure target also has the _cw_rh index (older tables may predate it)
      if (deltaReplace && targetExists) {
        const idxReq2 = pool.request();
        (idxReq2 as unknown as { overrides: { requestTimeout: number } }).overrides.requestTimeout = 7_200_000;
        await idxReq2.query(
          `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'${schema}.${tableName}') AND name=N'IX__cw_rh')
             CREATE NONCLUSTERED INDEX [IX__cw_rh] ON ${target} ([_cw_rh])`,
        );
      }

      // ── Atomic transaction ───────────────────────────────────────────────────
      const tx = new sql.Transaction(pool);
      await tx.begin();
      try {
        const request = new sql.Request(tx);
        // overrides.requestTimeout is the correct mssql v12 field (not .timeout which is a no-op)
        (request as unknown as { overrides: { requestTimeout: number } }).overrides.requestTimeout = 7_200_000;
        const targetColDefs = typedColumnDefs(mapping);
        const colList = mapping.map(c => quoteIdentifier(c.sqlName)).join(",");
        // Typed staging: staging already has correct types — direct column copy, no TRY_CONVERT.
        // NVARCHAR(MAX) staging (truncation fallback): must use TRY_CONVERT to cast strings to types.
        const typedSelect = stagingIsTyped
          ? mapping.map(c => `s.${quoteIdentifier(c.sqlName)}`).join(",")
          : mapping.map(c => typedSelectExpr(c, "s")).join(",");

        if (phase2) {
          // Phase 2: new rows already BULK inserted into target.
          // Delete removed rows using batched IN clauses — avoids #cw_del temp table compilation issue.
          const insertStats = await request.query(`
            INSERT INTO ${target} (${colList},[_cw_rh])
              SELECT ${typedSelect},s.[_cw_rh] FROM ${staging} s
              WHERE NOT EXISTS(SELECT 1 FROM ${target} t WHERE t.[_cw_rh]=s.[_cw_rh])
            OPTION (MAXDOP 1);
            SELECT @@ROWCOUNT inserted;
          `);
          inserted = Number(insertStats.recordset[0]?.inserted ?? total);
          if (toDelete.length > 0) {
            const BATCH = 500;
            for (let i = 0; i < toDelete.length; i += BATCH) {
              const batch = toDelete.slice(i, i + BATCH);
              // Hashes are validated as /^[0-9a-f]{32}$/ at the API layer — safe to inline
              const placeholders = batch.map(h => `'${h}'`).join(",");
              const delRes = await request.query(
                `DELETE FROM ${target} WHERE [_cw_rh] IN (${placeholders}); SELECT @@ROWCOUNT deleted;`,
              );
              updated += Number(delRes.recordset[0]?.deleted ?? 0);
            }
          }
          await request.query(`DROP TABLE ${staging}`);
        } else if (deltaReplace) {
          // Phase 1: full file in staging — INSERT new rows, DELETE removed rows.
          // MAXDOP 1 on INSERT reduces log writer contention on Azure SQL (Brent Ozar finding).
          const deltaStats = await request.query(`
            DECLARE @ins INT, @del INT;
            INSERT INTO ${target} (${colList},[_cw_rh])
              SELECT ${typedSelect},s.[_cw_rh] FROM ${staging} s
              WHERE NOT EXISTS(SELECT 1 FROM ${target} t WHERE t.[_cw_rh]=s.[_cw_rh])
            OPTION (MAXDOP 1);
            SET @ins=@@ROWCOUNT;
            DELETE t FROM ${target} t
              WHERE NOT EXISTS(SELECT 1 FROM ${staging} s WHERE s.[_cw_rh]=t.[_cw_rh]);
            SET @del=@@ROWCOUNT;
            DROP TABLE ${staging};
            SELECT @ins inserted, @del deleted;
          `);
          inserted = Number(deltaStats.recordset[0]?.inserted ?? 0);
          updated = Number(deltaStats.recordset[0]?.deleted ?? 0);
        } else if (upload.mode === "replace" || !targetExists) {
          // Full replace via staging (schema mismatch fallback when OPENROWSET not used)
          if (targetExists) await request.query(`DROP TABLE ${target}`);
          await request.query(`
            CREATE TABLE ${target} (${targetColDefs},[_cw_rh] CHAR(32) NULL);
            INSERT INTO ${target} (${colList},[_cw_rh])
              SELECT ${typedSelect},s.[_cw_rh] FROM ${staging} s
            OPTION (MAXDOP 1);
            CREATE INDEX [IX__cw_rh] ON ${target} ([_cw_rh]);
            DROP TABLE ${staging};
          `);
          inserted = total;
        } else if (upload.mode === "append") {
          await request.query(
            `INSERT INTO ${target} (${mapping.map(c => quoteIdentifier(c.sqlName)).join(",")})
             SELECT ${typedSelect} FROM ${staging} s
             OPTION (MAXDOP 1);
             DROP TABLE ${staging}`,
          );
          inserted = total;
        } else {
          // Upsert: DELETE matched rows + INSERT all from staging (1.5-1.8× faster than MERGE,
          // less index fragmentation — see RESEARCH.md #4)
          if (!upload.keyColumn) throw new Error("Upsert exige coluna-chave");
          const key = quoteIdentifier(upload.keyColumn);
          const keyColumn = mapping.find(c => c.sqlName === upload.keyColumn);
          if (!keyColumn) throw new Error("Coluna-chave não encontrada no arquivo");
          const keyExpr = typedSelectExpr(keyColumn, "s");
          const duplicates = await request.query(
            `SELECT ${key}, COUNT(*) n FROM ${staging} GROUP BY ${key} HAVING COUNT(*) > 1`,
          );
          if (duplicates.recordset.length) throw new Error("Arquivo contém chaves duplicadas para upsert");
          const upsertStats = await request.query(`
            DECLARE @del INT, @ins INT;
            DELETE t FROM ${target} t
              WHERE EXISTS (SELECT 1 FROM ${staging} s WHERE t.${key} = ${keyExpr});
            SET @del = @@ROWCOUNT;
            INSERT INTO ${target} (${mapping.map(c => quoteIdentifier(c.sqlName)).join(",")})
              SELECT ${mapping.map(c => typedSelectExpr(c, "s")).join(",")} FROM ${staging} s
            OPTION (MAXDOP 1);
            SET @ins = @@ROWCOUNT;
            DROP TABLE ${staging};
            SELECT @del updated, @ins inserted;
          `);
          updated = Number(upsertStats.recordset[0]?.updated ?? 0);
          inserted = Number(upsertStats.recordset[0]?.inserted ?? 0);
        }

        const countStr = (await request.query(`SELECT COUNT_BIG(*) count FROM ${target}`)).recordset[0].count as string;
        actual = BigInt(countStr);

        const MAX_BIGINT = 9223372036854775807n;
        if (actual > MAX_BIGINT || actual < 0n)
          throw new Error(`Row count ${countStr} exceeds BIGINT range. Verifique a integridade dos dados.`);

        await tx.commit();
        if (typeof deleteCleanBlob === "function") await deleteCleanBlob();
      } catch (e) {
        await tx.rollback().catch(() => undefined);
        throw e;
      }
    }

    // ── Integrity guard ───────────────────────────────────────────────────────
    // For full replace (no delta, no phase2), physical row count MUST equal the number of
    // rows parsed from the file (written to clean blob / staging).  A mismatch means BULK
    // INSERT or the staging INSERT SELECT silently dropped rows — never mark COMPLETED.
    const isFullReplace = (upload.mode === "replace" || !targetExists) && !deltaReplace && !phase2;
    if (isFullReplace && actual !== BigInt(total)) {
      throw new Error(
        `[integrity] Contagem inconsistente: arquivo produziu ${total} linhas mas tabela física tem ${actual.toString()} linhas. ` +
        `Upload marcado FAILED para evitar publicação de dados desatualizados.`,
      );
    }

    // ── Metadata updates (both paths) ─────────────────────────────────────────
    const MAX_BIGINT = 9223372036854775807n;
    if (actual > MAX_BIGINT || actual < 0n)
      throw new Error(`Row count ${actual.toString()} exceeds BIGINT range. Verifique a integridade dos dados.`);

    if (canUseOpenrowset && typeof deleteCleanBlob === "function") await deleteCleanBlob();

    // Upsert table record
    const table = upload.table ?? await prisma.datasetTable.upsert({
      where: { datasetId_sqlName: { datasetId: upload.dataset.id, sqlName: tableName } },
      update: {},
      create: { datasetId: upload.dataset.id, name: tableName, sqlName: tableName },
    });

    const deltaMode = phase2 ? "phase2" : deltaReplace ? "delta-replace" : (upload.mode === "replace" || !targetExists) ? "full-replace" : upload.mode;
    const totalMs = Date.now() - importStarted;
    phaseTimings.previewRows = knownRowCount;
    phaseTimings.parsedRows = total;
    phaseTimings.physicalRows = Number(actual);
    phaseTimings.totalImportMs = totalMs;
    phaseTimings.parseMethod = parseStats.parseMethod ?? null;
    phaseTimings.parseMs = parseStats.parseMs ?? null;
    phaseTimings.fileEncoding = parseStats.fileEncoding ?? null;
    phaseTimings.fileSeparator = parseStats.fileSeparator ?? null;
    phaseTimings.fallbackReason = parseStats.fallbackReason ?? null;
    phaseTimings.deltaMode = deltaMode;
    phaseTimings.toDeleteCount = updated;
    phaseTimings.stagingWasPartial = stagingIsPartial;
    phaseTimings.wasIdempotentRetry = stagingHasData;
    phaseTimings.rowsPerSecond = totalMs > 0 ? Math.round(total / (totalMs / 1000)) : null;
    console.log("[importUpload:perf]", JSON.stringify({ uploadId: upload.id, file: upload.originalFilename, rows: Number(actual), ...phaseTimings }));

    // Update metadata in Postgres via Prisma (single transaction)
    await prisma.$transaction([
      prisma.datasetColumn.deleteMany({ where: { tableId: table.id } }),
      prisma.datasetColumn.createMany({
        data: mapping.map((c, i) => ({
          tableId: table.id,
          ordinal: i + 1,
          originalName: c.originalName,
          sqlName: c.sqlName,
          sqlType: c.sqlType,
          nullable: c.nullable,
        })),
      }),
      prisma.datasetTable.update({
        where: { id: table.id },
        data: { rowCount: actual, lastDataAt: new Date() },
      }),
      prisma.datasetVersion.create({
        data: {
          tableId: table.id,
          uploadId: upload.id,
          rowCount: actual,
          schemaJson: JSON.stringify(mapping),
        },
      }),
      prisma.auditEvent.create({
        data: {
          eventType: "UPLOAD_IMPORT_PERF",
          resourceType: "upload",
          resourceId: upload.id,
          detailJson: JSON.stringify({ file: upload.originalFilename, rows: Number(actual), ...phaseTimings }),
          success: true,
        },
      }),
      prisma.upload.update({
        where: { id: upload.id },
        data: {
          tableId: table.id,
          status: "COMPLETED",
          progress: 100,
          rowCount: actual,
          insertedCount: inserted,
          updatedCount: updated,
          errorMessage: null,
        },
      }),
    ]);

    return { tableId: table.id, inserted, updated, rowCount: actual };
  } catch (e) {
    // Best-effort: drop staging on any failure (no-op for OPENROWSET path — no staging was created)
    await pool.request()
      .query(`IF OBJECT_ID(N'${schema}.${stage}',N'U') IS NOT NULL DROP TABLE ${staging}`)
      .catch(() => undefined);
    throw e;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function deleteBulkCleanBlob(cleanBlobName: string): Promise<void> {
  try {
    if (!env().CATWORLD_AZURE_BLOB_CONNECTION_STRING) return;
    const { BlobServiceClient } = await import("@azure/storage-blob");
    const { env: getEnv } = await import("@/server/env");
    const e = getEnv();
    const s = BlobServiceClient.fromConnectionString(e.CATWORLD_AZURE_BLOB_CONNECTION_STRING!);
    await s.getContainerClient(e.CATWORLD_AZURE_BLOB_CONTAINER).getBlockBlobClient(cleanBlobName).delete().catch(() => {});
  } catch { /* best-effort */ }
}

async function checkStagingHasData(pool: sql.ConnectionPool, schema: string, stage: string): Promise<number> {
  try {
    const r = await pool.request().query(
      `SELECT CASE WHEN OBJECT_ID(N'${schema}.${stage}',N'U') IS NOT NULL
              THEN (SELECT COUNT_BIG(*) FROM ${quoteIdentifier(schema)}.${quoteIdentifier(stage)})
              ELSE 0 END n`,
    );
    return Number(r.recordset[0].n);
  } catch {
    return 0;
  }
}

async function checkHasDeltaCol(pool: sql.ConnectionPool, schema: string, table: string): Promise<boolean> {
  try {
    const r = await pool.request()
      .input("schema", sql.NVarChar, schema)
      .input("table", sql.NVarChar, table)
      .query("SELECT 1 ok FROM sys.columns WHERE object_id=OBJECT_ID(QUOTENAME(@schema)+'.'+QUOTENAME(@table)) AND name='_cw_rh'");
    return r.recordset.length > 0;
  } catch { return false; }
}

async function schemaMatchesSilent(pool: sql.ConnectionPool, schema: string, table: string, mapping: ParsedColumn[]): Promise<boolean> {
  try {
    const result = await pool.request()
      .input("schema", sql.NVarChar, schema)
      .input("table", sql.NVarChar, table)
      .query("SELECT c.name, ty.name type_name, c.precision, c.scale, c.is_nullable FROM sys.columns c JOIN sys.types ty ON c.user_type_id=ty.user_type_id WHERE c.object_id=OBJECT_ID(QUOTENAME(@schema)+'.'+QUOTENAME(@table)) ORDER BY c.column_id");
    const rows = result.recordset as { name: string; type_name: string; precision: number; scale: number; is_nullable: boolean }[];
    const dataRows = rows.filter(r => r.name !== "_cw_rh");
    const actual = dataRows.map(r => r.name);
    const expected = mapping.map(c => c.sqlName);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) return false;
    return dataRows.every((r, i) => physicalTypeMatches(r, mapping[i]!.sqlType) && r.is_nullable);
  } catch { return false; }
}

async function assertCompatible(request: sql.Request, schema: string, table: string, columns: ParsedColumn[]) {
  const result = await request
    .input("schema", sql.NVarChar, schema)
    .input("table", sql.NVarChar, table)
    .query("SELECT c.name, t.name type_name, c.precision, c.scale FROM sys.columns c JOIN sys.types t ON c.user_type_id=t.user_type_id WHERE c.object_id=OBJECT_ID(QUOTENAME(@schema)+'.'+QUOTENAME(@table)) ORDER BY c.column_id");
  const actualRows = result.recordset.filter((r: Record<string, unknown>) => String(r.name) !== "_cw_rh") as { name: string; type_name: string; precision: number; scale: number }[];
  const actual = actualRows.map(r => r.name);
  const expected = columns.map(c => c.sqlName);
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`Schema incompatível. Esperado: ${expected.join(", ")}; atual: ${actual.join(", ")}`);
  if (!actualRows.every((r, i) => physicalTypeMatches(r, columns[i]!.sqlType)))
    throw new Error("Schema incompatível: tipos da tabela atual diferem do arquivo");
}

function physicalTypeMatches(row: { type_name: string; precision?: number; scale?: number }, expected: string) {
  const type = row.type_name.toLowerCase();
  if (expected === "BIGINT") return type === "bigint";
  if (expected.startsWith("DECIMAL")) return type === "decimal" && Number(row.precision) === 18 && Number(row.scale) === 4;
  if (expected === "DATE") return type === "date";
  if (expected === "DATETIME2") return type === "datetime2";
  if (expected === "TIME") return type === "time";
  return type === "nvarchar";
}

export function convert(v: unknown, type: string) {
  if (v == null || String(v).trim() === "") return null;
  if (type === "BIGINT") return String(v);
  if (type.startsWith("DECIMAL")) {
    const s = String(v).trim();
    return Number(s.includes(",") ? s.replaceAll(".", "").replace(",", ".") : s);
  }
  if (type === "DATE" || type === "DATETIME2") {
    const s = String(v).trim();
    const iso = normalizeDateLike(s) ?? s;
    return new Date(type === "DATE" ? iso.slice(0, 10) + "T00:00:00Z" : iso);
  }
  if (type === "TIME") return String(v).trim();
  return String(v);
}
