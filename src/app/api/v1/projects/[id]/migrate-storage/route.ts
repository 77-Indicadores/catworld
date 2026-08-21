/**
 * POST /api/v1/projects/[id]/migrate-storage
 *
 * Migra todos os datasets do projeto para um StorageServer de destino.
 * Para cada dataset: copia o schema + tabelas do SQL Server de origem para o destino,
 * depois atualiza storage_server_id. Não remove dados da origem.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import sql from "mssql";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { handleApiError, ok, ApiError } from "@/server/http";
import { getStoragePool } from "@/server/storage/pool";
import { quoteIdentifier } from "@/server/security/naming";

const bodySchema = z.object({ targetStorageServerId: z.string().uuid() });

async function copySchema(
  srcPool: sql.ConnectionPool,
  dstPool: sql.ConnectionPool,
  schema: string,
): Promise<{ table: string; rows: number }[]> {
  const qSchema = quoteIdentifier(schema);
  const esc = (s: string) => s.replaceAll("'", "''");

  // Cria schema no destino
  await dstPool.request().query(
    `IF SCHEMA_ID(N'${esc(schema)}') IS NULL EXEC(N'CREATE SCHEMA ${qSchema}')`,
  );

  // Lista tabelas na origem
  const tablesRes = await srcPool.request()
    .input("schema", sql.NVarChar(128), schema)
    .query<{ name: string }>(
      `SELECT t.name FROM sys.tables t JOIN sys.schemas s ON t.schema_id=s.schema_id WHERE s.name=@schema ORDER BY t.name`,
    );

  const results: { table: string; rows: number }[] = [];

  for (const { name: table } of tablesRes.recordset) {
    const qTable = quoteIdentifier(table);
    const qFull = `${qSchema}.${qTable}`;

    // Colunas da origem
    const colsRes = await srcPool.request()
      .input("schema", sql.NVarChar(128), schema)
      .input("table", sql.NVarChar(128), table)
      .query<{ col: string; type: string; max_len: number; prec: number; scale: number; nullable: number; is_identity: number }>(
        `SELECT c.name col, ty.name type, c.max_length max_len, c.precision prec, c.scale scale,
                c.is_nullable nullable, c.is_identity
         FROM sys.columns c JOIN sys.types ty ON c.user_type_id=ty.user_type_id
         WHERE c.object_id=OBJECT_ID(QUOTENAME(@schema)+'.'+QUOTENAME(@table)) ORDER BY c.column_id`,
      );

    const cols = colsRes.recordset;
    if (!cols.length) continue;

    // DDL da tabela no destino
    const colDefs = cols.map((c) => {
      const q = quoteIdentifier(c.col);
      const nullable = c.nullable ? "NULL" : "NOT NULL";
      const t = c.type.toLowerCase();
      if (["nvarchar", "varchar", "nchar", "char"].includes(t)) {
        const len = c.max_len === -1 ? "MAX" : String(t.startsWith("n") ? c.max_len / 2 : c.max_len);
        return `${q} ${c.type.toUpperCase()}(${len}) ${nullable}`;
      }
      if (["decimal", "numeric"].includes(t)) return `${q} ${c.type.toUpperCase()}(${c.prec},${c.scale}) ${nullable}`;
      if (["datetime2", "time", "datetimeoffset"].includes(t)) return `${q} ${c.type.toUpperCase()}(${c.scale}) ${nullable}`;
      return `${q} ${c.type.toUpperCase()} ${nullable}`;
    });

    await dstPool.request().query(
      `IF OBJECT_ID(N'${esc(schema)}.${esc(table)}',N'U') IS NOT NULL DROP TABLE ${qFull}`,
    );
    await dstPool.request().query(`CREATE TABLE ${qFull} (${colDefs.join(", ")})`);

    // Copia dados em batches
    const nonIdentity = cols.filter((c) => !c.is_identity);
    const selectCols = nonIdentity.map((c) => quoteIdentifier(c.col)).join(", ");
    let offset = 0;
    const batchSize = 2000;
    let totalRows = 0;

    while (true) {
      const batchRes = await srcPool.request().query<Record<string, unknown>>(
        `SELECT ${selectCols} FROM ${qFull} ORDER BY (SELECT NULL) OFFSET ${offset} ROWS FETCH NEXT ${batchSize} ROWS ONLY`,
      );
      const rows = batchRes.recordset;
      if (!rows.length) break;

      const bulkTable = new sql.Table(qFull);
      bulkTable.create = false;
      for (const c of nonIdentity) bulkTable.columns.add(c.col, sql.NVarChar(sql.MAX), { nullable: true });
      for (const row of rows) bulkTable.rows.add(...nonIdentity.map((c) => {
        const v = row[c.col]; return v === null || v === undefined ? null : String(v);
      }));

      await new sql.Request(dstPool).bulk(bulkTable);
      totalRows += rows.length;
      offset += batchSize;
      if (rows.length < batchSize) break;
    }

    results.push({ table, rows: totalRows });
  }

  return results;
}

export async function POST(r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(r);
    requireRole(actor, ["ADMIN"]);
    const projectId = (await params).id;
    const { targetStorageServerId } = bodySchema.parse(await r.json());

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, datasets: { where: { active: true }, select: { id: true, schemaName: true, storageServerId: true } } },
    });
    if (!project) throw new ApiError(404, "NOT_FOUND", "Projeto não encontrado");

    const datasetsToMigrate = project.datasets.filter(d => d.storageServerId !== targetStorageServerId);
    if (!datasetsToMigrate.length) throw new ApiError(400, "ALREADY_ON_TARGET", "Todos os datasets já estão neste servidor");

    const dstPool = await getStoragePool(targetStorageServerId);
    const datasetResults: { datasetId: string; schema: string; tables: { table: string; rows: number }[] }[] = [];

    for (const dataset of datasetsToMigrate) {
      const srcPool = await getStoragePool(dataset.storageServerId);
      const tables = await copySchema(srcPool, dstPool, dataset.schemaName);
      await prisma.dataset.update({ where: { id: dataset.id }, data: { storageServerId: targetStorageServerId } });
      datasetResults.push({ datasetId: dataset.id, schema: dataset.schemaName, tables });
    }

    return ok({ datasetsMigrated: datasetResults.length, datasets: datasetResults });
  } catch (e) {
    return handleApiError(e);
  }
}
