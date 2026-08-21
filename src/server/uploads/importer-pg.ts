/**
 * importUploadPg — importa um arquivo para um dataset em PostgreSQL storage.
 *
 * Funcionalidades suportadas:
 *   - replace  (full replace via staging + rename)
 *   - append   (INSERT direto no target)
 *   - upsert   (DELETE matched + INSERT from staging)
 *
 * Não suportadas neste adapter (só existem no caminho mssql):
 *   - OPENROWSET / BULK INSERT via Azure Blob
 *   - delta replace (phase1/phase2)
 */

import { extname } from "node:path";
import { createHash } from "node:crypto";
import { prisma } from "@/server/db";
import { sqlIdentifier } from "@/server/security/naming";
import { previewFile, rowsFromFile, type FilePreview, type ParsedColumn, type RowsFromFileOpts } from "./parser";
import { normalizeDateLike } from "./date-normalize";
import type { PgStorageConnection } from "@/server/storage/pg-storage";
import { pgQuote, canonicalToPg } from "@/server/storage/pg-storage";

// ─── Type conversion ──────────────────────────────────────────────────────────

/** Converte valor raw para string que o Postgres aceita via unnest cast */
function convertForPg(v: unknown, sqlType: string): string | null {
  const s = v == null ? "" : String(v).trim();
  if (!s) return null;

  if (sqlType === "BIGINT") {
    if (!/^-?\d+$/.test(s)) return null;
    return s;
  }
  if (sqlType.startsWith("DECIMAL")) {
    const lastDot = s.lastIndexOf(".");
    const lastComma = s.lastIndexOf(",");
    const cleaned = lastComma > lastDot
      ? s.replaceAll(".", "").replace(",", ".")   // BR: "1.234,56"
      : s.replaceAll(",", "");                    // US: "1,234.56"
    const n = Number.parseFloat(cleaned);
    if (!Number.isFinite(n) || Math.abs(n) >= 1e14) return null;
    return String(n);
  }
  if (sqlType === "DATE" || sqlType === "DATETIME2") {
    const d = normalizeDateLike(s);
    if (!d) return null;
    return d;
  }
  if (sqlType === "TIME") return s;
  // TEXT
  return s.replace(/\x00/g, "") || null;
}

// ─── Batch flush ─────────────────────────────────────────────────────────────

const BATCH_SIZE = 2000;

async function flushBatch(
  conn: PgStorageConnection,
  schema: string,
  table: string,
  mapping: ParsedColumn[],
  batch: Record<string, unknown>[],
  withRh: boolean,
): Promise<void> {
  if (!batch.length) return;

  const cols = [...mapping.map(c => c.sqlName), ...(withRh ? ["_cw_rh"] : [])];
  const colList = cols.map(pgQuote).join(", ");
  const params: (string | null)[][] = cols.map(() => []);

  for (const row of batch) {
    for (let j = 0; j < mapping.length; j++) {
      const c = mapping[j]!;
      params[j]!.push(convertForPg(row[c.sqlName], c.sqlType));
    }
    if (withRh) {
      const rh = createHash("md5")
        .update(mapping.map(c => String(row[c.sqlName] ?? "")).join("|"))
        .digest("hex");
      params[mapping.length]!.push(rh);
    }
  }

  const canonTypes = mapping.map(c => canonicalToPg(c.sqlType));
  const unnestExprs = mapping.map((_, i) => `unnest($${i + 1}::text[])::${canonTypes[i]}`);
  if (withRh) unnestExprs.push(`unnest($${mapping.length + 1}::text[])`);

  const qTable = `${pgQuote(schema)}.${pgQuote(table)}`;
  await conn._pool.query(
    `INSERT INTO ${qTable} (${colList}) SELECT ${unnestExprs.join(", ")}`,
    params,
  );
}

// ─── Column DDL ──────────────────────────────────────────────────────────────

function colDefs(mapping: ParsedColumn[], withRh: boolean): string {
  const cols = mapping.map(c => `${pgQuote(c.sqlName)} ${canonicalToPg(c.sqlType)} NULL`);
  if (withRh) cols.push(`"_cw_rh" TEXT NULL`);
  return cols.join(", ");
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function importUploadPg(
  uploadId: string,
  source: string | NodeJS.ReadableStream,
  conn: PgStorageConnection,
) {
  const importStarted = Date.now();

  const upload = await prisma.upload.findUniqueOrThrow({
    where: { id: uploadId },
    include: { dataset: true, table: true },
  });
  if (!upload.dataset) throw new Error("Dataset não definido");

  const mapping = (upload.mappingJson
    ? JSON.parse(upload.mappingJson) as ParsedColumn[]
    : (await previewFile(source as string)).columns);

  if (!mapping.length) throw new Error("Nenhuma coluna mapeada — verifique o mapeamento");

  const ext = extname(upload.originalFilename).toLowerCase();
  const tableName = upload.table?.sqlName ?? sqlIdentifier(upload.originalFilename.replace(/\.[^.]+$/, ""));
  const schema = upload.dataset.schemaName;
  const stage = `cw_stage_${upload.id.replaceAll("-", "").slice(0, 20)}`;

  const qSchema = pgQuote(schema);
  const qTarget = `${qSchema}.${pgQuote(tableName)}`;
  const qStaging = `${qSchema}.${pgQuote(stage)}`;

  await conn.createSchemaIfNotExists(schema);

  const preview = upload.previewJson ? JSON.parse(upload.previewJson) as FilePreview : null;
  const opts: RowsFromFileOpts = {
    encoding: preview?.encoding ?? "utf8",
    separator: preview?.separator ?? ",",
    ext,
  };
  const knownRowCount = Number(upload.rowCount ?? 0);

  // Valida compatibilidade antes de criar staging (append/upsert em target existente)
  const targetExists = await conn.tableExists(schema, tableName);
  if ((upload.mode === "append" || upload.mode === "upsert") && targetExists) {
    const existingCols = await conn.listColumns(schema, tableName);
    const existingNames = existingCols.filter(c => c.name !== "_cw_rh").map(c => c.name);
    const incomingNames = mapping.map(c => c.sqlName);
    if (JSON.stringify(existingNames) !== JSON.stringify(incomingNames)) {
      throw new Error(`Schema incompatível. Esperado: ${incomingNames.join(", ")}; atual: ${existingNames.join(", ")}`);
    }
  }

  // Drop staging anterior (retry idempotente)
  await conn.execute(`DROP TABLE IF EXISTS ${qStaging}`);
  await conn.execute(`CREATE TABLE ${qStaging} (${colDefs(mapping, true)})`);

  let total = 0;
  let lastProgressMs = Date.now();
  let batch: Record<string, unknown>[] = [];

  for await (const row of rowsFromFile(source, mapping, opts)) {
    batch.push(row);
    if (batch.length >= BATCH_SIZE) {
      await flushBatch(conn, schema, stage, mapping, batch, true);
      total += batch.length;
      batch = [];
      const now = Date.now();
      if (now - lastProgressMs > 10_000) {
        void prisma.upload.update({
          where: { id: upload.id },
          data: { progress: Math.min(75, 35 + Math.floor(total / Math.max(knownRowCount, 1) * 40)) },
        });
        lastProgressMs = now;
      }
    }
  }
  await flushBatch(conn, schema, stage, mapping, batch, true);
  total += batch.length;

  // Índice em _cw_rh para upserts/deltas futuros
  await conn.execute(`CREATE INDEX ON ${qStaging} ("_cw_rh")`);

  // ── Transação atômica ────────────────────────────────────────────────────────

  let inserted = total, updated = 0;
  const colList = mapping.map(c => pgQuote(c.sqlName)).join(", ");
  const colListWithRh = colList + `, "_cw_rh"`;
  const targetColDefs = colDefs(mapping, true);

  await conn.withClient(async (client) => {
    await client.query("BEGIN");
    try {
      if (upload.mode === "replace" || !targetExists) {
        // Full replace: drop + create + INSERT from staging
        await client.query(`DROP TABLE IF EXISTS ${qTarget}`);
        await client.query(`CREATE TABLE ${qTarget} (${targetColDefs})`);
        await client.query(`INSERT INTO ${qTarget} (${colListWithRh}) SELECT ${colListWithRh} FROM ${qStaging}`);
        await client.query(`CREATE INDEX ON ${qTarget} ("_cw_rh")`);
        await client.query(`DROP TABLE ${qStaging}`);
        inserted = total;

      } else if (upload.mode === "append") {
        await client.query(`INSERT INTO ${qTarget} (${colList}) SELECT ${colList} FROM ${qStaging}`);
        await client.query(`DROP TABLE ${qStaging}`);
        inserted = total;

      } else if (upload.mode === "upsert") {
        if (!upload.keyColumn) throw new Error("Upsert exige coluna-chave");
        const key = pgQuote(upload.keyColumn);

        // Verifica chaves duplicadas no arquivo
        const dupRes = await client.query<{ n: string }>(
          `SELECT COUNT(*) AS n FROM (SELECT ${key}, COUNT(*) c FROM ${qStaging} GROUP BY ${key} HAVING COUNT(*) > 1) x`,
        );
        if (Number(dupRes.rows[0]?.n) > 0) throw new Error("Arquivo contém chaves duplicadas para upsert");

        const delRes = await client.query(
          `DELETE FROM ${qTarget} t USING ${qStaging} s WHERE t.${key} = s.${key}`,
        );
        updated = delRes.rowCount ?? 0;
        await client.query(
          `INSERT INTO ${qTarget} (${colList}) SELECT ${colList} FROM ${qStaging}`,
        );
        await client.query(`DROP TABLE ${qStaging}`);
        inserted = total;
      }

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      // Cleanup staging em caso de erro
      await conn.execute(`DROP TABLE IF EXISTS ${qStaging}`).catch(() => undefined);
      throw e;
    }
  });

  const actual = await conn.countRows(schema, tableName);

  // Integridade: full replace deve ter a mesma contagem que o arquivo
  if ((upload.mode === "replace" || !targetExists) && actual !== BigInt(total)) {
    throw new Error(
      `[integrity] Arquivo produziu ${total} linhas mas tabela física tem ${actual.toString()} linhas.`,
    );
  }

  // ── Atualiza metadados no Postgres ────────────────────────────────────────────
  const table = upload.table ?? await prisma.datasetTable.upsert({
    where: { datasetId_sqlName: { datasetId: upload.dataset.id, sqlName: tableName } },
    update: {},
    create: { datasetId: upload.dataset.id, name: tableName, sqlName: tableName },
  });

  const totalMs = Date.now() - importStarted;
  console.log("[importUploadPg:perf]", JSON.stringify({
    uploadId: upload.id,
    file: upload.originalFilename,
    rows: Number(actual),
    totalImportMs: totalMs,
    importMethod: "pg-unnest-batch",
    rowsPerSecond: totalMs > 0 ? Math.round(total / (totalMs / 1000)) : null,
  }));

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
}
