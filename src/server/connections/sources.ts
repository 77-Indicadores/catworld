import { randomUUID } from "crypto";
import sql from "mssql";
import { prisma } from "@/server/db";
import { sqlPool, ensureSchema } from "@/server/azure/sql";
import { quoteIdentifier, sqlIdentifier } from "@/server/security/naming";
import { ApiError } from "@/server/http";
import { queryColumns, quotedPgTable, streamPostgresRows, tableColumns, type SourceColumn } from "./postgres";
import { queryColumnsMssql, quotedMssqlTable, streamMssqlRows, tableColumnsMssql } from "./mssql";

export type RefreshPolicy = "manual" | "hourly" | "daily" | "weekly";

export function nextRefresh(policy: string, from = new Date()) {
  if (policy === "hourly") return new Date(from.getTime() + 60 * 60_000);
  if (policy === "daily") return new Date(from.getTime() + 24 * 60 * 60_000);
  if (policy === "weekly") return new Date(from.getTime() + 7 * 24 * 60 * 60_000);
  return null;
}

export async function queueSourceRefresh(datasetSourceId: string) {
  const existing = await prisma.job.findFirst({
    where: {
      type: "SOURCE_REFRESH",
      status: { in: ["QUEUED", "RUNNING"] },
      payloadJson: JSON.stringify({ datasetSourceId }),
    },
  });
  if (existing) return existing;
  return prisma.job.create({ data: { type: "SOURCE_REFRESH", payloadJson: JSON.stringify({ datasetSourceId }), maxAttempts: 3, weight: 2 } });
}

export async function enqueueDueSourceRefreshes() {
  const due = await prisma.datasetSource.findMany({
    where: {
      active: true,
      mode: "extract",
      refreshPolicy: { in: ["hourly", "daily", "weekly"] },
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
  refreshPolicy: RefreshPolicy;
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
      refreshPolicy: input.mode === "live" ? "manual" : input.refreshPolicy,
      lastStatus: input.mode === "live" ? "ready" : "queued",
      nextRefreshAt: input.mode === "extract" ? nextRefresh(input.refreshPolicy) : null,
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
  refreshPolicy: RefreshPolicy;
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
      refreshPolicy: input.refreshPolicy,
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
  const query = source.sourceKind === "table"
    ? `SELECT * FROM ${isMssql ? quotedMssqlTable(source.sourceSchema!, source.sourceTable!) : quotedPgTable(source.sourceSchema!, source.sourceTable!)}`
    : source.sourceSql!;
  const columns = source.sourceKind === "table"
    ? (isMssql ? await tableColumnsMssql(source.connection, source.sourceSchema!, source.sourceTable!) : await tableColumns(source.connection, source.sourceSchema!, source.sourceTable!))
    : (isMssql ? await queryColumnsMssql(source.connection, source.sourceSql!) : await queryColumns(source.connection, source.sourceSql!));
  const pool = await sqlPool();
  const schema = source.dataset.schemaName;
  const table = source.targetTable.sqlName;
  const stage = `cw_src_${source.id.replaceAll("-", "").slice(0, 20)}`;
  const target = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
  const staging = `${quoteIdentifier(schema)}.${quoteIdentifier(stage)}`;
  let rowCount = 0n;

  await prisma.datasetSource.update({ where: { id: source.id }, data: { lastStatus: "running", lastError: null } });
  await ensureSchema(schema);
  await pool.request().query(`IF OBJECT_ID(N'${schema}.${stage}',N'U') IS NOT NULL DROP TABLE ${staging}; CREATE TABLE ${staging} (${columnDefs(columns)})`);
  try {
    for await (const rows of (isMssql ? streamMssqlRows(source.connection, query, 1000) : streamPostgresRows(source.connection, query, 1000))) {
      await bulkInsertRows(pool, schema, stage, columns, rows);
      rowCount += BigInt(rows.length);
    }
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const req = new sql.Request(tx);
      if (await targetExists(req, schema, table)) await req.query(`DROP TABLE ${target}`);
      await req.query(`EXEC sp_rename '${schema}.${stage}', '${table}'`);
      await tx.commit();
    } catch (e) {
      await tx.rollback().catch(() => undefined);
      throw e;
    }
    await replaceColumnCatalog(source.targetTable.id, columns, rowCount);
    await prisma.datasetSource.update({
      where: { id: source.id },
      data: {
        lastStatus: "completed",
        lastRowCount: rowCount,
        lastError: null,
        lastRefreshedAt: new Date(),
        nextRefreshAt: nextRefresh(source.refreshPolicy),
      },
    });
    return { rowCount };
  } catch (e) {
    await pool.request().query(`IF OBJECT_ID(N'${schema}.${stage}',N'U') IS NOT NULL DROP TABLE ${staging}`).catch(() => undefined);
    const message = e instanceof Error ? e.message : String(e);
    await prisma.datasetSource.update({ where: { id: source.id }, data: { lastStatus: "failed", lastError: message, nextRefreshAt: nextRefresh(source.refreshPolicy) } });
    throw e;
  }
}

async function targetExists(req: sql.Request, schema: string, table: string) {
  const result = await req.query(`SELECT CASE WHEN OBJECT_ID(N'${schema}.${table}',N'U') IS NULL THEN 0 ELSE 1 END n`);
  return Number(result.recordset[0]?.n ?? 0) === 1;
}

function columnDefs(columns: SourceColumn[]) {
  return columns.map((c) => `${quoteIdentifier(c.sqlName)} ${sqlType(c.sqlType)} NULL`).join(",");
}

function sqlType(type: string) {
  if (type === "BIGINT") return "BIGINT";
  if (type.startsWith("DECIMAL")) return "DECIMAL(18,4)";
  if (type === "DATE") return "DATE";
  if (type === "DATETIME2") return "DATETIME2";
  if (type === "TIME") return "TIME";
  return "NVARCHAR(MAX)";
}

async function bulkInsertRows(pool: sql.ConnectionPool, schema: string, table: string, columns: SourceColumn[], rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const bulk = new sql.Table(`${schema}.${table}`);
  bulk.create = false;
  for (const column of columns) bulk.columns.add(column.sqlName, tdsType(column.sqlType), { nullable: true });
  for (const row of rows) bulk.rows.add(...columns.map((column) => convert(row[column.originalName], column.sqlType)) as Parameters<typeof bulk.rows.add>);
  await new sql.Request(pool).bulk(bulk, { tableLock: true });
}

function tdsType(type: string): sql.ISqlType | (() => sql.ISqlType) {
  if (type === "BIGINT") return sql.BigInt;
  if (type.startsWith("DECIMAL")) return sql.Decimal(18, 4);
  if (type === "DATE") return sql.Date;
  if (type === "DATETIME2") return sql.DateTime2;
  if (type === "TIME") return sql.Time;
  return sql.NVarChar(sql.MAX);
}

function convert(value: unknown, type: string) {
  if (value == null) return null;
  if (type === "BIGINT") return Number(value);
  if (type.startsWith("DECIMAL")) return Number(value);
  if (type === "DATE" || type === "DATETIME2") return value instanceof Date ? value : new Date(String(value));
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
