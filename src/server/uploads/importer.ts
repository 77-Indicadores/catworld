import * as Sentry from "@sentry/nextjs";
import { physicalDecimal, parseDecimalType, DECIMAL_LEGACY } from "@/lib/decimal-type";
import { IntegrityError, evaluateLoad, getIntegritySettings, type Evaluation } from "@/server/integrity/policy";
import { auditIntegrity, evaluationDetail, ledgerInsert, recordLedger } from "@/server/integrity/ledger";
import { MSSQL_MARKER_DDL, MSSQL_MARKER_INSERT, MSSQL_MARKER_SELECT } from "./applied-marker";
import { canonicalAccepts, incompatibleColumns, incompatibleMessage, mssqlPhysicalToCanonical } from "./type-compat";
import { isInternalColumn } from "@/server/storage/connection";
import { extname } from "node:path";
import sql from "mssql";
import { prisma } from "@/server/db";
import { withAdvisoryLock } from "@/server/db/advisory-lock";
import { withImportLock, type Lease } from "@/server/db/import-lock";
import { sqlPool } from "@/server/azure/sql";
import { getStoragePool } from "@/server/storage/pool";
import { getStorageConnection, type ColDef } from "@/server/storage/connection";
import { quoteIdentifier, sqlIdentifier } from "@/server/security/naming";
import { previewFile, rowsFromFile, type FilePreview, type ParsedColumn, type RowsFromFileOpts, type ParseStats } from "./parser";
import { env } from "@/server/env";
import { normalizeDateLike } from "./date-normalize";
import { convertForTds, decimalTsqlExpr } from "./convert-values";


function sqlTypeDef(type: string): string {
  if (type === "BIGINT") return "BIGINT";
  if (type.startsWith("DECIMAL")) return physicalDecimal(type, "mssql");
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

export function typedSelectExpr(column: ParsedColumn, alias: string): string {
  const value = cleanedRef(column, alias);
  if (column.sqlType === "BIGINT") return `TRY_CONVERT(BIGINT,${value})`;
  if (column.sqlType.startsWith("DECIMAL")) return decimalTsqlExpr(value, column);
  // Convenção dd/mm × mm/dd é da COLUNA (decidida pelo arquivo inteiro): só o estilo dela entra no COALESCE, nunca os dois por valor.
  const slashStyle = column.dateOrder === "mdy" ? 101 : 103;
  const styles = (iso: number[]) => column.dateOrder ? [...iso, slashStyle] : [...iso, 103, 101]; // sem convenção (mapeamento antigo): legado
  if (column.sqlType === "DATE") {
    return `COALESCE(${styles([23, 126]).map(st => `TRY_CONVERT(DATE,${value},${st})`).join(",")})`;
  }
  if (column.sqlType === "DATETIME2") {
    return `COALESCE(${styles([126, 120]).map(st => `TRY_CONVERT(DATETIME2,${value},${st})`).join(",")})`;
  }
  if (column.sqlType === "TIME") return `TRY_CONVERT(TIME,${value})`;
  return `${alias}.${quoteIdentifier(column.sqlName)}`;
}

// ─── Typed staging helpers ────────────────────────────────────────────────────

/** SQL type for the staging table column — mirrors typedCsvField in importer-bulk-blob.ts */
function stagingColType(sqlType: string): string {
  if (sqlType === "BIGINT") return "BIGINT";
  if (sqlType.startsWith("DECIMAL")) return physicalDecimal(sqlType, "mssql");
  if (sqlType === "DATE") return "DATE";
  if (sqlType === "DATETIME2") return "DATETIME2";
  if (sqlType === "TIME") return "TIME";
  if (sqlType === "NVARCHAR(MAX)") return "NVARCHAR(MAX)";
  return "NVARCHAR(4000)";
}

/** mssql column type for TDS bulk copy into a typed staging table */
function tdsColType(sqlType: string): sql.ISqlType | (() => sql.ISqlType) {
  if (sqlType === "BIGINT") return sql.BigInt;
  if (sqlType.startsWith("DECIMAL")) { const d = parseDecimalType(sqlType) ?? DECIMAL_LEGACY; return sql.Decimal(d.precision, d.scale); }
  if (sqlType === "DATE") return sql.Date;
  if (sqlType === "DATETIME2") return sql.DateTime2;
  if (sqlType === "TIME") return sql.Time;
  if (sqlType === "NVARCHAR(MAX)") return sql.NVarChar(sql.MAX);
  return sql.NVarChar(4000);
}

// ─── TDS bulk copy ────────────────────────────────────────────────────────────
// Used as the primary path for small CSVs/XLS and as automatic fallback when
// BULK INSERT fails with an OLE DB provider error.
const MSSQL_BIGINT_MIN = -9223372036854775808n, MSSQL_BIGINT_MAX = 9223372036854775807n;

function mssqlBigIntOverflows(s: string): boolean {
  if (!s || !/^-?\d+$/.test(s)) return false;
  try { const b = BigInt(s); return b < MSSQL_BIGINT_MIN || b > MSSQL_BIGINT_MAX; } catch { return false; }
}

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
): Promise<{ total: number; reclassifiedCols: string[] }> {
  const { getWorkerConfig } = await import("@/server/worker/config");
  const { importBatchDelayMs: batchDelay } = await getWorkerConfig();
  const stringify = (v: unknown) => (v == null || String(v).trim() === "" ? null : String(v));

  let batch: Record<string, unknown>[] = [];
  let total = 0;
  const reclassifiedCols: string[] = [];

  const flush = async () => {
    if (!batch.length) return;

    // Detecta overflow BIGINT antes do bulk copy — sem perda de dados
    if (typed) {
      for (let i = 0; i < mapping.length; i++) {
        const c = mapping[i]!;
        if (c.sqlType !== "BIGINT") continue;
        const hasOverflow = batch.some(row => mssqlBigIntOverflows(String(row[c.sqlName] ?? "").trim()));
        if (!hasOverflow) continue;
        // ALTER TABLE staging: BIGINT → NVARCHAR(MAX)
        await new sql.Request(pool).query(
          `ALTER TABLE ${quoteIdentifier(schema)}.${quoteIdentifier(destTable)} ALTER COLUMN ${quoteIdentifier(c.sqlName)} NVARCHAR(MAX)`,
        );
        mapping[i]!.sqlType = "NVARCHAR(MAX)";
        if (!reclassifiedCols.includes(c.sqlName)) reclassifiedCols.push(c.sqlName);
      }
    }

    const bulk = new sql.Table(`${schema}.${destTable}`);
    bulk.create = false;
    for (const c of mapping) {
      bulk.columns.add(c.sqlName, typed ? tdsColType(c.sqlType) : sql.NVarChar(sql.MAX), { nullable: true });
    }
    bulk.columns.add("_cw_rh", sql.Char(32), { nullable: true });
    const { createHash: ch } = await import("node:crypto");
    for (const row of batch) {
      const vals = typed
        ? mapping.map(c => convertForTds(row[c.sqlName], c))
        : mapping.map(c => stringify(row[c.sqlName]));
      const rh = ch("md5").update(mapping.map(c => String(row[c.sqlName] ?? "")).join("|")).digest("hex");
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

  if (reclassifiedCols.length) {
    console.warn("[tdsBulkCopy] colunas reclassificadas BIGINT→NVARCHAR por overflow 64-bit: %s upload=%s",
      reclassifiedCols.join(", "), uploadId);
  }
  console.log("[tdsBulkCopy] upload=%s rows=%d", uploadId, total);
  return { total, reclassifiedCols };
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
  if (upload.table && upload.table.datasetId !== upload.dataset.id) throw new Error("Tabela do upload não pertence ao dataset de destino");

  let mapping = (upload.mappingJson
    ? JSON.parse(upload.mappingJson)
    : (await previewFile(source as string)).columns) as ParsedColumn[];
  const knownRowCount = Number(upload.rowCount ?? 0);

  // mappingJson pode ser [] quando o preview não detectou colunas (arquivo vazio/sem cabeçalho).
  // Nesse caso, tenta re-detectar a partir do arquivo; se ainda estiver vazio, conclui com 0 linhas.
  if (!mapping.length && upload.mappingJson) {
    mapping = (await previewFile(source as string)).columns;
  }
  if (!mapping.length) {
    // Arquivo sem colunas não carrega nada e não pode contar como concluído (a tabela não foi tocada): FAILED, com motivo.
    await prisma.upload.update({
      where: { id: upload.id },
      data: { status: "FAILED", progress: 100, insertedCount: 0, updatedCount: 0, errorMessage: "Arquivo sem colunas: nada foi importado e a tabela não foi alterada." },
    });
    return { tableId: upload.tableId ?? null, inserted: 0, updated: 0, rowCount: 0n };
  }

  const tableName = upload.table?.sqlName ?? sqlIdentifier(upload.originalFilename.replace(/\.[^.]+$/, ""));
  const schema = upload.dataset.schemaName;

  // Serializa TODO o import por dataset+tabela a partir daqui (staging DDL,
  // criação de índice, swap atômico, escrita de metadata) — não só o passo
  // final de metadata (ver withAdvisoryLock mais abaixo, que fica redundante
  // mas inofensivo dentro deste lock mais amplo). Sem isso, dois uploads
  // concorrentes pra mesma tabela nova liam ambos targetExists=false e
  // disparavam CREATE TABLE / CREATE INDEX um em cima do outro ("There is
  // already an object named ...", "index or statistics ... already exists").
  //
  // Usa withImportLock (lock por linha em cw_import_locks, sem transação
  // Postgres de vida longa) em vez do antigo withAdvisoryLockForString
  // (pg_advisory_xact_lock dentro de prisma.$transaction com timeout fixo).
  // Motivo da troca: o trabalho protegido aqui é externo (SQL Server) e pode
  // legitimamente demorar minutos por lock de leitura concorrente na tabela
  // física (DROP TABLE do swap exige lock exclusivo) — isso não tem relação
  // com o Postgres, então não devia poder estourar timeout de transação
  // Postgres. Visto em produção: vendas_completo/ADL falhando ~4x/dia com
  // "Transaction already closed" após 13-18min mesmo em arquivos pequenos
  // que normalmente levam <2min.
  try {
    return await withImportLock(`${upload.dataset.id}:${schema}.${tableName}`, importUploadForTable);
  } catch (e) {
    // Cada tentativa que falha vira uma linha no livro de integridade e, se for a barra de integridade, um evento de auditoria (success=false).
    const entry = {
      kind: "upload" as const, outcome: "FAILED" as const, verdict: (e instanceof IntegrityError ? e.evaluation.verdict : "FAILED") as "FAILED" | "SUSPECT" | "OK",
      datasetId: upload.dataset.id, uploadId, tableName,
      ...(e instanceof IntegrityError ? e.facts : {}),
      detail: e instanceof IntegrityError ? evaluationDetail(e.evaluation, { storage: "sqlserver" }) : { error: (e instanceof Error ? e.message : String(e)).slice(0, 500), storage: "sqlserver" },
    };
    await recordLedger(entry);
    if (e instanceof IntegrityError) await auditIntegrity({ ...entry, resourceId: uploadId });
    throw e;
  }

  async function importUploadForTable(lease: Lease) {
    const stage = `cw_stage_${upload.id.replaceAll("-", "").slice(0, 20)}`;
    const pool = await getStoragePool(upload.dataset!.storageServerId);
    // StorageConnection reutiliza o mesmo pool interno (singleton por storageServerId)
    const storageConn = await getStorageConnection(upload.dataset!.storageServerId);
    // Pool de escrita separado: DDL de staging e bulk copies usam o pool do MssqlStorageConnection
    // para não saturar o pool de leitura que serve a API e o OData.
    const writePool = await (storageConn as unknown as { rawPool(): Promise<sql.ConnectionPool> }).rawPool();
    const target = `${quoteIdentifier(schema)}.${quoteIdentifier(tableName)}`;
    const staging = `${quoteIdentifier(schema)}.${quoteIdentifier(stage)}`;

    // Typed staging: Node.js pre-converts values (typedCsvField) so BULK INSERT writes native types
    // and the delta INSERT SELECT becomes a direct column copy — no TRY_CONVERT on Azure SQL (saves DTU).
    // colDefsMax is kept as fallback when a NVARCHAR value exceeds 4000 chars (rare truncation error).
    const colDefs    = mapping.map(c => `${quoteIdentifier(c.sqlName)} ${stagingColType(c.sqlType)} NULL`).join(",") + ",[_cw_rh] CHAR(32) NULL";
    const colDefsMax = mapping.map(c => `${quoteIdentifier(c.sqlName)} NVARCHAR(MAX)  NULL`).join(",") + ",[_cw_rh] CHAR(32) NULL";
    // Set to false if truncation forces NVARCHAR(MAX) fallback — INSERT SELECT must use TRY_CONVERT then
    const stagingIsTyped = true;

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
    // O arquivo deste upload só tem a DIFERENÇA. Se a tabela mudou desde que ela foi calculada (schema/coluna de hash), tratar como
    // replace completo trocaria a tabela inteira por um arquivo parcial: recusa.
    if (upload.deltaJson != null && !phase2) {
      throw new Error("Este upload traz apenas a diferença (deltaJson), mas a tabela mudou desde que ela foi calculada. Reenvie o arquivo completo.");
    }

    const ext = extname(upload.originalFilename).toLowerCase();

    // ── Staging: SEMPRE recarrega do zero ──────────────────────────────────────────────────────────────────
    // Reaproveitar a staging de uma tentativa anterior (o antigo "retry idempotente") publicou tabelas incompletas em produção
    // (50 mil, 300 mil, 600 mil e 650 mil de 828.672 linhas): a staging de uma tentativa que morreu no meio fica com parte das linhas
    // e nada prova que está completa (sem dono, sem token, contagem esperada nem sempre conhecida). Recarregar custa tempo;
    // publicar dado incompleto custa o dado. Ver docs/estudo-confiabilidade-dados.md (MOT-05/MOT-09).
    const leftoverStaging = await checkStagingHasData(pool, schema, stage);
    if (leftoverStaging > 0) {
      console.warn("[importUpload] staging de tentativa anterior descartada (%d linhas) — recarregando do zero upload=%s", leftoverStaging, uploadId);
    }
    const stagingHasData = false;

    // Marca exactly-once (append): se este upload já foi aplicado (queda entre o COMMIT e os metadados), não recarrega nem acrescenta
    // de novo — só reconcilia os metadados.
    await writePool.request().query(MSSQL_MARKER_DDL);
    let alreadyAppliedRows: number | null = null;
    if (upload.mode === "append") {
      const m = await pool.request().input("uploadId", sql.UniqueIdentifier, upload.id).query(MSSQL_MARKER_SELECT);
      if (m.recordset.length > 0) alreadyAppliedRows = Number(m.recordset[0].rows);
    }
    const alreadyApplied = alreadyAppliedRows !== null;

    await writePool.request().query(
      `IF OBJECT_ID(N'${schema}.${stage}',N'U') IS NOT NULL DROP TABLE ${staging};
       CREATE TABLE ${staging} (${colDefs})`,
    );

    let total = 0, inserted = 0, updated = 0;
    let evaluation: Evaluation = { verdict: "OK", reasons: [] };
    let prevRowsForLedger = 0;
    let lastProgressMs = Date.now();
    let actual = 0n;
    const reclassifiedCols: string[] = [];

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

      {
        // ── Staging path (TDS bulk copy via mssql driver) ─────────────────────────
        const destTable = stage;

        if (alreadyApplied) {
          total = alreadyAppliedRows!;
          phaseTimings.importMethod = "already-applied";
        } else {
          phaseTimings.importMethod = "tds-primary";
          const _r = await tdsBulkCopy(writePool, source, mapping, schema, destTable, opts, knownRowCount, uploadId, onProgress, true, parseStats);
          total = _r.total; reclassifiedCols.push(..._r.reclassifiedCols);
        }

        // Index staging._cw_rh so NOT EXISTS lookups are O(n log n) instead of O(n²)
        // Large staging tables can take >10 min to index — needs explicit 2h timeout.
        if (!stagingHasData) {
          const idxReq = writePool.request();
          (idxReq as unknown as { overrides: { requestTimeout: number } }).overrides.requestTimeout = 7_200_000;
          await idxReq.query(
            `IF OBJECT_ID(N'${schema}.${stage}',N'U') IS NOT NULL
               CREATE NONCLUSTERED INDEX [IX_stage_rh] ON ${staging} ([_cw_rh])`,
          );
        }
        // Ensure target also has the _cw_rh index (older tables may predate it)
        if (deltaReplace && targetExists) {
          const idxReq2 = writePool.request();
          (idxReq2 as unknown as { overrides: { requestTimeout: number } }).overrides.requestTimeout = 7_200_000;
          await idxReq2.query(
            `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'${schema}.${tableName}') AND name=N'IX__cw_rh')
               CREATE NONCLUSTERED INDEX [IX__cw_rh] ON ${target} ([_cw_rh])`,
          );
        }

        // ── Atomic swap / transaction ────────────────────────────────────────────
        // deltaReplace e upsert usam atomicSwap (lock ~ms em produção).
        // phase2, replace e append mantêm o caminho de transação original.
        // _cw_rh é sempre um hash MD5 hex (32 chars, fixo) — em todo outro lugar
        // do arquivo é declarado CHAR(32) (colDefs/colDefsMax acima, full replace
        // abaixo). Aqui estava NVARCHAR(MAX) por engano: como atomicSwap (upsert/
        // mergeSwap) usa esse mapping pra CREATE TABLE da tabela mesclada que vira
        // o novo target, isso deixava _cw_rh permanentemente NVARCHAR(MAX) na
        // tabela física — e NVARCHAR(MAX) nunca pode ser coluna de índice no SQL
        // Server, então um replace/upsert seguinte que tenta garantir o índice
        // IX__cw_rh nessa tabela falha com "Column '_cw_rh' ... invalid for use
        // as a key column in an index" (visto em producao em cta_economia_por_veiculo
        // e outras tabelas que já passaram por upsert).
        // ── Integridade ANTES de publicar: carregado x esperado x versão anterior ──────────────────────────────────
        // (docs/estudo-confiabilidade-dados.md, OBS-01/OBS-05). Antes, a única checagem comparava a tabela com a própria contagem
        // da staging, então nunca falhava. FAILED = não troca nada: a tabela anterior continua no ar, completa.
        if (!alreadyApplied) {
          const meta = upload.table ?? await prisma.datasetTable.findUnique({ where: { datasetId_sqlName: { datasetId: upload.dataset!.id, sqlName: tableName } }, select: { rowCount: true } });
          const prevRows = targetExists ? Number(meta?.rowCount ?? (await storageConn.countRows(schema, tableName))) : 0;
          prevRowsForLedger = prevRows;
          evaluation = evaluateLoad({
            kind: "upload",
            fullState: !phase2 && (upload.mode === "replace" || !targetExists || (upload.mode === "upsert" && upload.fullSnapshot)),
            deltaOnly: phase2,
            expectedRows: knownRowCount,
            parsedRows: total,
            stagedRows: total,
            prevRows,
            scheduled: false,
          }, await getIntegritySettings());
          if (evaluation.verdict === "FAILED") {
            await writePool.request().query(`IF OBJECT_ID(N'${schema}.${stage}',N'U') IS NOT NULL DROP TABLE ${staging}`).catch(() => undefined);
            throw new IntegrityError(evaluation, { expectedRows: knownRowCount, parsedRows: total, prevRows });
          }
          if (evaluation.verdict === "SUSPECT") console.warn("[importUpload:integrity] SUSPECT upload=%s %s", uploadId, JSON.stringify(evaluation.reasons));
        }

        // Ainda sou o dono do lock? Se o lease se perdeu, outro import pode ter mexido na tabela: abortar ANTES de publicar.
        lease.assert();

        const mappingWithRh: ColDef[] = [
          ...mapping.map(c => ({ name: c.sqlName, sqlType: c.sqlType, nullable: true })),
          { name: "_cw_rh", sqlType: "CHAR(32)", nullable: true },
        ];

        if (deltaReplace && !phase2) {
          // fullSwap: staging tem o estado completo novo — DROP target + RENAME staging (lock ~ms)
          await storageConn.atomicSwap(schema, stage, tableName, mappingWithRh, { targetExists });
          inserted = total; updated = 0;
          actual = await storageConn.countRows(schema, tableName);
        } else if (upload.mode === "upsert") {
          // mergeSwap: mantém rows de target cujo key NÃO está em staging + todos de staging (lock ~ms)
          if (!upload.keyColumn) throw new Error("Upsert exige coluna-chave");
          const key = quoteIdentifier(upload.keyColumn);
          // Chave nula nunca casa com nada: cada execução inseria a linha de novo. Recusa antes de mesclar.
          const nullKeys = await pool.request().query(`SELECT COUNT_BIG(*) n FROM ${staging} WHERE ${key} IS NULL`);
          if (Number(nullKeys.recordset[0].n) > 0) {
            throw new Error(`Arquivo contém ${nullKeys.recordset[0].n} linha(s) com chave nula na coluna "${upload.keyColumn}": upsert exige chave preenchida em todas as linhas.`);
          }
          const duplicates = await pool.request().query(
            `SELECT TOP 20 ${key} AS k, COUNT(*) n FROM ${staging} GROUP BY ${key} HAVING COUNT(*) > 1`,
          );
          if (duplicates.recordset.length) {
            const sample = duplicates.recordset.map((r: { k: unknown; n: number }) => `${r.k} (x${r.n})`).join(", ");
            const more = duplicates.recordset.length >= 20 ? " (mostrando as primeiras 20)" : "";
            throw new Error(`Arquivo contém chaves duplicadas para upsert na coluna "${upload.keyColumn}": ${sample}${more}`);
          }
          const mergedName = `cw_mgd_${upload.id.replaceAll("-", "").slice(0, 20)}`;
          await storageConn.atomicSwap(schema, stage, tableName, mappingWithRh, {
            targetExists, keyColumn: upload.keyColumn, mergedName, fullSnapshot: upload.fullSnapshot,
          });
          inserted = total; updated = 0;
          actual = await storageConn.countRows(schema, tableName);
        } else {
          // Transação original para: phase2, replace, append
          const tx = new sql.Transaction(writePool);
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
              // exactly-once: a marca entra na MESMA transação do INSERT
              request.input("uploadId", sql.UniqueIdentifier, upload.id);
              request.input("tableName", sql.NVarChar, tableName);
              request.input("mode", sql.NVarChar, "append");
              request.input("rows", sql.BigInt, total);
              await request.query(MSSQL_MARKER_INSERT);
              inserted = total;
            }

            const countStr = (await request.query(`SELECT COUNT_BIG(*) count FROM ${target}`)).recordset[0].count as string;
            actual = BigInt(countStr);

            const MAX_BIGINT = 9223372036854775807n;
            if (actual > MAX_BIGINT || actual < 0n)
              throw new Error(`Row count ${countStr} exceeds BIGINT range. Verifique a integridade dos dados.`);

            await tx.commit();
            } catch (e) {
            await tx.rollback().catch(() => undefined);
            throw e;
          }
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

      // Upsert table record
      const table = upload.table ?? await prisma.datasetTable.upsert({
        where: { datasetId_sqlName: { datasetId: upload.dataset!.id, sqlName: tableName } },
        update: {},
        create: { datasetId: upload.dataset!.id, name: tableName, sqlName: tableName },
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
      if (reclassifiedCols.length) phaseTimings.reclassifiedCols = reclassifiedCols;
      phaseTimings.toDeleteCount = updated;
      phaseTimings.stagingWasPartial = leftoverStaging > 0; // sobra de tentativa anterior (descartada)
      phaseTimings.wasIdempotentRetry = alreadyApplied;      // append já aplicado (marca exactly-once)
      phaseTimings.rowsPerSecond = totalMs > 0 ? Math.round(total / (totalMs / 1000)) : null;
      console.log("[importUpload:perf]", JSON.stringify({ uploadId: upload.id, file: upload.originalFilename, rows: Number(actual), ...phaseTimings }));

      // Update metadata in Postgres via Prisma (single transaction).
      // Guarded by an advisory lock on table.id: concurrent uploads that target the same
      // dataset table (e.g. parallel workers appending to the same file/table) would otherwise
      // race between the deleteMany and createMany below, tripping the (table_id, sql_name)
      // unique constraint on datasetColumn.
      await withAdvisoryLock(table.id, () => prisma.$transaction([
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
        ledgerInsert({
          kind: "upload", outcome: "COMPLETED", verdict: evaluation.verdict, datasetId: upload.dataset!.id, tableId: table.id, uploadId: upload.id,
          tableName, mode: upload.mode, expectedRows: knownRowCount, parsedRows: total, physicalRows: Number(actual), prevRows: prevRowsForLedger,
          detail: evaluationDetail(evaluation, { importMethod: phaseTimings.importMethod, parseMethod: parseStats.parseMethod, fallbackReason: parseStats.fallbackReason, storage: "sqlserver" }),
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
      ]));

      return { tableId: table.id, inserted, updated, rowCount: actual };
    } catch (e) {
      // Best-effort: drop staging on any failure (no-op para OPENROWSET path — sem staging criado)
      await writePool.request()
        .query(`IF OBJECT_ID(N'${schema}.${stage}',N'U') IS NOT NULL DROP TABLE ${staging}`)
        .catch(() => undefined);
      throw e;
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
    const dataRows = rows.filter(r => !isInternalColumn(r.name));
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
  const actualRows = result.recordset.filter((r: Record<string, unknown>) => !isInternalColumn(String(r.name))) as { name: string; type_name: string; precision: number; scale: number }[];
  const actual = actualRows.map(r => r.name);
  const expected = columns.map(c => c.sqlName);
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`Schema incompatível. Esperado: ${expected.join(", ")}; atual: ${actual.join(", ")}`);
  if (!actualRows.every((r, i) => physicalTypeMatches(r, columns[i]!.sqlType)))
    throw new Error("Schema incompatível: tipos da tabela atual diferem do arquivo");
}

function physicalTypeMatches(row: { type_name: string; precision?: number; scale?: number }, expected: string) {
  // Só é aceito ALARGAR: o valor do arquivo sempre cabe na coluna física sem perder informação (ver type-compat.ts).
  // Antes, DECIMAL aceitava coluna inteira e DATETIME2 aceitava coluna DATE (1,5 virava 2; a hora sumia).
  return canonicalAccepts(mssqlPhysicalToCanonical(row), expected);
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
