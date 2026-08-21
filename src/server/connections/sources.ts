import { randomUUID } from "crypto";
import sql from "mssql";
import { Cron } from "croner";
import { prisma } from "@/server/db";
import { sqlPool, ensureSchema } from "@/server/azure/sql";
import { getStoragePool } from "@/server/storage/pool";
import { getStorageConnection } from "@/server/storage/connection";
import { quoteIdentifier, sqlIdentifier } from "@/server/security/naming";
import { ApiError } from "@/server/http";
import { queryColumns, quotedPgTable, streamPostgresRows, tableColumns, type SourceColumn } from "./postgres";
import { queryColumnsMssql, quotedMssqlTable, streamMssqlRows, tableColumnsMssql } from "./mssql";

export function nextRefreshFromCron(cronExpr: string | null | undefined, from = new Date()): Date | null {
  if (!cronExpr) return null;
  try {
    return new Cron(cronExpr, { timezone: "UTC" }).nextRun(from) ?? null;
  } catch {
    return null;
  }
}

function advisoryLockKey(id: string): bigint {
  // Convert first 15 hex chars of UUID (no dashes) to a positive bigint for pg_advisory_lock
  return BigInt("0x" + id.replace(/-/g, "").slice(0, 15));
}

export async function queueSourceRefresh(datasetSourceId: string) {
  // Use Postgres advisory lock to prevent race condition where two workers both see "no existing job"
  // and both insert, creating duplicate SOURCE_REFRESH jobs for the same source.
  const lockKey = advisoryLockKey(datasetSourceId);
  await prisma.$executeRawUnsafe(`SELECT pg_advisory_lock(${lockKey})`);
  try {
    const existing = await prisma.job.findFirst({
      where: { type: "SOURCE_REFRESH", status: { in: ["QUEUED", "RUNNING"] }, payloadJson: JSON.stringify({ datasetSourceId }) },
    });
    if (existing) {
      if (existing.status === "QUEUED") {
        await prisma.datasetSource.update({ where: { id: datasetSourceId }, data: { lastStatus: "queued", lastError: null } });
      }
      return existing;
    }
    const [job] = await prisma.$transaction([
      prisma.job.create({ data: { type: "SOURCE_REFRESH", payloadJson: JSON.stringify({ datasetSourceId }), maxAttempts: 3, weight: 2 } }),
      prisma.datasetSource.update({ where: { id: datasetSourceId }, data: { lastStatus: "queued", lastError: null } }),
    ]);
    return job;
  } finally {
    await prisma.$executeRawUnsafe(`SELECT pg_advisory_unlock(${lockKey})`).catch(() => {});
  }
}

export async function enqueueDueSourceRefreshes() {
  const due = await prisma.datasetSource.findMany({
    where: {
      active: true,
      mode: "extract",
      refreshCron: { not: null },
      nextRefreshAt: { lte: new Date() },
    },
    select: { id: true },
    take: 20,
  });
  for (const source of due) await queueSourceRefresh(source.id);
}

export async function createDatasetSource(input: {
  datasetId: string;
  connectionId: string;
  name?: string;
  mode: "extract" | "live";
  sourceKind: "table" | "query";
  sourceSchema?: string | null;
  sourceTable?: string | null;
  sourceSql?: string | null;
  refreshCron?: string | null;
  keyColumn?: string | null;
  sourceGroupId?: string;
}) {
  const [dataset, connection] = await Promise.all([
    prisma.dataset.findUnique({ where: { id: input.datasetId }, include: { project: true } }),
    prisma.connection.findUnique({ where: { id: input.connectionId } }),
  ]);
  if (!dataset) throw new ApiError(404, "DATASET_NOT_FOUND", "Dataset nao encontrado");
  if (!connection || !connection.active) throw new ApiError(404, "CONNECTION_NOT_FOUND", "Conexao nao encontrada");
  if (!["postgres", "mssql"].includes(connection.provider)) throw new ApiError(400, "UNSUPPORTED_PROVIDER", `Provider ${connection.provider} nao suportado`);
  if (input.sourceKind === "table" && (!input.sourceSchema || !input.sourceTable)) throw new ApiError(400, "INVALID_SOURCE", "Tabela exige schema e nome");
  if (input.sourceKind === "query" && !input.sourceSql?.trim()) throw new ApiError(400, "INVALID_SOURCE", "Consulta obrigatoria");

  const columns = input.sourceKind === "table"
    ? (connection.provider === "mssql" ? await tableColumnsMssql(connection, input.sourceSchema!, input.sourceTable!) : await tableColumns(connection, input.sourceSchema!, input.sourceTable!))
    : (connection.provider === "mssql" ? await queryColumnsMssql(connection, input.sourceSql!) : await queryColumns(connection, input.sourceSql!));
  if (!columns.length) throw new ApiError(400, "EMPTY_SOURCE", "Fonte nao retornou colunas");

  const displayName = input.sourceKind === "table" ? input.sourceTable! : input.name!;
  const tableName = sqlIdentifier(displayName);
  const table = await prisma.datasetTable.upsert({
    where: { datasetId_sqlName: { datasetId: dataset.id, sqlName: tableName } },
    update: { name: displayName },
    create: { datasetId: dataset.id, name: displayName, sqlName: tableName },
  });
  await replaceColumnCatalog(table.id, columns, 0n);

  const source = await prisma.datasetSource.create({
    data: {
      datasetId: dataset.id,
      connectionId: connection.id,
      targetTableId: table.id,
      name: displayName,
      mode: input.mode,
      sourceKind: input.sourceKind,
      sourceGroupId: input.sourceGroupId ?? null,
      sourceSchema: input.sourceSchema ?? null,
      sourceTable: input.sourceTable ?? null,
      sourceSql: input.sourceSql ?? null,
      keyColumn: input.keyColumn ?? null,
      refreshCron: input.mode === "live" ? null : (input.refreshCron ?? null),
      lastStatus: input.mode === "live" ? "ready" : "queued",
      nextRefreshAt: input.mode === "extract" ? nextRefreshFromCron(input.refreshCron) : null,
    },
    include: { connection: true, targetTable: { include: { columns: { orderBy: { ordinal: "asc" } } } } },
  });
  if (input.mode === "extract") await queueSourceRefresh(source.id);
  return source;
}

export async function createDatasetSources(input: {
  datasetId: string;
  connectionId: string;
  mode: "extract" | "live";
  sourceSchema: string;
  sourceTables: string[];
  refreshCron?: string | null;
  sourceGroupId?: string;
}) {
  const sourceGroupId = input.sourceGroupId ?? randomUUID();
  const sources = [];
  for (const table of input.sourceTables) {
    sources.push(await createDatasetSource({
      datasetId: input.datasetId,
      connectionId: input.connectionId,
      mode: input.mode,
      sourceKind: "table",
      sourceSchema: input.sourceSchema,
      sourceTable: table,
      refreshCron: input.refreshCron,
      sourceGroupId,
    }));
  }
  return sources;
}

export async function refreshDatasetSource(datasetSourceId: string) {
  const source = await prisma.datasetSource.findUnique({
    where: { id: datasetSourceId },
    include: { dataset: true, connection: true, targetTable: true },
  });
  if (!source || !source.active) throw new ApiError(404, "SOURCE_NOT_FOUND", "Fonte não encontrada");
  if (source.mode !== "extract") throw new ApiError(400, "INVALID_SOURCE_MODE", "Apenas fontes extract podem ser atualizadas");
  if (!source.targetTable) throw new ApiError(400, "SOURCE_NO_TARGET_TABLE", "Fonte sem tabela de destino");

  const isMssql = source.connection.provider === "mssql";

  // Delta: only fetch rows newer than lastDeltaValue (table sources only, requires keyColumn for upsert)
  const useDelta = !!(source.deltaColumn && source.lastDeltaValue && source.keyColumn && source.sourceKind === "table");
  const baseTableQuery = source.sourceKind === "table"
    ? `SELECT * FROM ${isMssql ? quotedMssqlTable(source.sourceSchema!, source.sourceTable!) : quotedPgTable(source.sourceSchema!, source.sourceTable!)}`
    : source.sourceSql!;
  const quoteCol = (col: string) => isMssql ? `[${col.replace(/]/g, "]]")}]` : `"${col.replace(/"/g, '""')}"`;
  const query = useDelta
    ? `${baseTableQuery} WHERE ${quoteCol(source.deltaColumn!)} > '${source.lastDeltaValue!.replace(/'/g, "''")}'`
    : baseTableQuery;

  const columns = source.sourceKind === "table"
    ? (isMssql ? await tableColumnsMssql(source.connection, source.sourceSchema!, source.sourceTable!) : await tableColumns(source.connection, source.sourceSchema!, source.sourceTable!))
    : (isMssql ? await queryColumnsMssql(source.connection, source.sourceSql!) : await queryColumns(source.connection, source.sourceSql!));

  const storageConn = await getStorageConnection(source.dataset.storageServerId);
  const schema = source.dataset.schemaName;
  const table = source.targetTable.sqlName;
  const stage = `cw_src_${source.id.replaceAll("-", "").slice(0, 20)}`;
  let rowCount = 0n;

  await prisma.datasetSource.update({ where: { id: source.id }, data: { lastStatus: "running", lastError: null } });
  await storageConn.createSchemaIfNotExists(schema);

  // Cria tabela staging com os tipos canônicos das colunas
  const stageCols = columns.map(c => ({ name: c.sqlName, sqlType: c.sqlType, nullable: true }));
  await storageConn.dropTableIfExists(schema, stage);
  await storageConn.createTable(schema, stage, stageCols);

  try {
    const STREAM_BATCH = 1000;
    for await (const rows of (isMssql ? streamMssqlRows(source.connection, query, STREAM_BATCH) : streamPostgresRows(source.connection, query, STREAM_BATCH))) {
      const bulkRows = rows.map(row => columns.map(c => convertSourceValue(row[c.originalName], c.sqlType)));
      await storageConn.bulkInsert(schema, stage, stageCols, bulkRows);
      rowCount += BigInt(rows.length);
    }

    // Captura novo delta ANTES de trocar/dropar staging
    let newDeltaValue: string | null | undefined = undefined;
    if (source.deltaColumn && source.sourceKind === "table" && source.keyColumn) {
      const col = storageConn.q(source.deltaColumn);
      const qStage = `${storageConn.q(schema)}.${storageConn.q(stage)}`;
      const res = await storageConn.query<{ v: unknown }>(`SELECT MAX(${col}) AS v FROM ${qStage}`);
      const v = res[0]?.v;
      if (v != null) newDeltaValue = v instanceof Date ? v.toISOString() : String(v);
    }

    // Swap atômico (upsert ou replace)
    const hasTarget = await storageConn.tableExists(schema, table);
    if (storageConn.provider === "sqlserver") {
      // mssql: usa pool raw para transação e sp_rename
      const pool = await (storageConn as import("@/server/storage/mssql-storage").MssqlStorageConnection).rawPool();
      const qTarget = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
      const qStaging = `${quoteIdentifier(schema)}.${quoteIdentifier(stage)}`;
      const tx = new sql.Transaction(pool);
      await tx.begin();
      try {
        const req = new sql.Request(tx);
        if (source.keyColumn && hasTarget) {
          const key = quoteIdentifier(source.keyColumn);
          const colList = columns.map((c) => quoteIdentifier(c.sqlName)).join(",");
          await req.query(`
            DELETE t FROM ${qTarget} t WHERE EXISTS (SELECT 1 FROM ${qStaging} s WHERE t.${key} = s.${key});
            INSERT INTO ${qTarget} (${colList}) SELECT ${colList} FROM ${qStaging};
            DROP TABLE ${qStaging};
          `);
        } else {
          if (hasTarget) await req.query(`DROP TABLE ${qTarget}`);
          await req.query(`EXEC sp_rename '${(schema as string).replaceAll("'", "''")}.${ (stage as string).replaceAll("'", "''")}', '${(table as string).replaceAll("'", "''")}'`);
        }
        await tx.commit();
      } catch (e) {
        await tx.rollback().catch(() => undefined);
        throw e;
      }
    } else {
      // postgres: usa transação via withClient
      const pgConn = storageConn as import("@/server/storage/pg-storage").PgStorageConnection;
      const { pgQuote } = await import("@/server/storage/pg-storage");
      const qTarget = `${pgQuote(schema)}.${pgQuote(table)}`;
      const qStaging = `${pgQuote(schema)}.${pgQuote(stage)}`;
      await pgConn.withClient(async (client: import("pg").PoolClient) => {
        await client.query("BEGIN");
        try {
          if (source.keyColumn && hasTarget) {
            const key = pgQuote(source.keyColumn);
            const colList = columns.map(c => pgQuote(c.sqlName)).join(", ");
            await client.query(`DELETE FROM ${qTarget} t USING ${qStaging} s WHERE t.${key} = s.${key}`);
            await client.query(`INSERT INTO ${qTarget} (${colList}) SELECT ${colList} FROM ${qStaging}`);
            await client.query(`DROP TABLE ${qStaging}`);
          } else {
            await client.query(`DROP TABLE IF EXISTS ${qTarget}`);
            await client.query(`ALTER TABLE ${qStaging} RENAME TO ${pgQuote(table)}`);
          }
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw e;
        }
      });
    }

    const finalRowCount = await storageConn.countRows(schema, table);

    await replaceColumnCatalog(source.targetTable.id, columns, finalRowCount);
    await prisma.datasetSource.update({
      where: { id: source.id },
      data: {
        lastStatus: "completed",
        lastRowCount: finalRowCount,
        lastError: null,
        lastRefreshedAt: new Date(),
        nextRefreshAt: nextRefreshFromCron(source.refreshCron),
        ...(newDeltaValue !== undefined ? { lastDeltaValue: newDeltaValue } : {}),
      },
    });
    return { rowCount: finalRowCount };
  } catch (e) {
    await storageConn.dropTableIfExists(schema, stage).catch(() => undefined);
    const message = e instanceof Error ? e.message : String(e);
    await prisma.datasetSource.update({
      where: { id: source.id },
      data: { lastStatus: "failed", lastError: message, nextRefreshAt: nextRefreshFromCron(source.refreshCron) },
    });
    throw e;
  }
}

/** Converte valor de fonte para string compatível com bulkInsert */
function convertSourceValue(value: unknown, type: string): string | null {
  if (value == null) return null;
  if (type === "BIGINT") {
    const s = typeof value === "bigint" ? value.toString() : String(value).trim();
    if (!/^-?\d+$/.test(s)) return null;
    return s;
  }
  if (type.startsWith("DECIMAL")) {
    const n = Number(value);
    if (!Number.isFinite(n) || Math.abs(n) >= 1e14) return null;
    return String(n);
  }
  if (type === "DATE" || type === "DATETIME2") {
    const d = value instanceof Date ? value : new Date(String(value));
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  }
  if (type === "TIME") return String(value);
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}


async function replaceColumnCatalog(tableId: string, columns: SourceColumn[], rowCount: bigint) {
  await prisma.$transaction([
    prisma.datasetColumn.deleteMany({ where: { tableId } }),
    prisma.datasetTable.update({ where: { id: tableId }, data: { rowCount, lastDataAt: new Date() } }),
    prisma.datasetColumn.createMany({
      data: columns.map((column, index) => ({
        tableId,
        ordinal: index + 1,
        originalName: column.originalName,
        sqlName: column.sqlName,
        sqlType: column.sqlType,
        nullable: column.nullable,
      })),
    }),
    prisma.datasetVersion.create({ data: { tableId, rowCount, schemaJson: JSON.stringify(columns) } }),
  ]);
}
