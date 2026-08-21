/**
 * POST /api/v1/projects/[id]/migrate-storage
 *
 * Migra todos os datasets do projeto para um StorageServer de destino.
 * Suporta cross-provider (sqlserver ↔ postgres).
 * Não remove dados da origem.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { handleApiError, ok, ApiError } from "@/server/http";
import { getStorageConnection } from "@/server/storage/connection";
import type { StorageConnection, ColDef } from "@/server/storage/connection";

const bodySchema = z.object({ targetStorageServerId: z.string().uuid() });

async function copySchema(
  src: StorageConnection,
  dst: StorageConnection,
  schema: string,
): Promise<{ table: string; rows: number }[]> {
  // Cria schema no destino
  await dst.createSchemaIfNotExists(schema);

  const tables = await src.listTables(schema);
  const results: { table: string; rows: number }[] = [];

  for (const table of tables) {
    const cols = await src.listColumns(schema, table);

    // Colunas internas (ex: _cw_rh) mantidas como tipo texto
    const colDefs: ColDef[] = cols.map(c => ({
      name: c.name,
      sqlType: c.sqlType,
      nullable: true,
    }));

    // Recria tabela no destino
    await dst.dropTableIfExists(schema, table);
    await dst.createTable(schema, table, colDefs);

    // Copia dados em batches via query raw na origem + bulkInsert no destino
    const BATCH = 2000;
    let offset = 0;
    let totalRows = 0;
    const srcQ = src.q(schema);
    const srcT = src.q(table);
    const colList = cols.map(c => src.q(c.name)).join(", ");

    // mssql usa OFFSET/FETCH, postgres usa LIMIT/OFFSET
    const page = (off: number) => src.provider === "sqlserver"
      ? `SELECT ${colList} FROM ${srcQ}.${srcT} ORDER BY (SELECT NULL) OFFSET ${off} ROWS FETCH NEXT ${BATCH} ROWS ONLY`
      : `SELECT ${colList} FROM ${srcQ}.${srcT} LIMIT ${BATCH} OFFSET ${off}`;

    while (true) {
      const rows = await src.query<Record<string, unknown>>(page(offset));
      if (!rows.length) break;

      const bulkRows = rows.map(row => cols.map(c => {
        const v = row[c.name];
        if (v == null) return null;
        if (v instanceof Date) return v.toISOString();
        return String(v);
      }));
      await dst.bulkInsert(schema, table, colDefs, bulkRows);

      totalRows += rows.length;
      offset += BATCH;
      if (rows.length < BATCH) break;
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
      select: {
        id: true,
        name: true,
        datasets: {
          where: { active: true },
          select: { id: true, schemaName: true, storageServerId: true },
        },
      },
    });
    if (!project) throw new ApiError(404, "NOT_FOUND", "Projeto não encontrado");

    const datasetsToMigrate = project.datasets.filter(d => d.storageServerId !== targetStorageServerId);
    if (!datasetsToMigrate.length) {
      throw new ApiError(400, "ALREADY_ON_TARGET", "Todos os datasets já estão neste servidor");
    }

    const dstConn = await getStorageConnection(targetStorageServerId);
    const datasetResults: { datasetId: string; schema: string; tables: { table: string; rows: number }[] }[] = [];

    for (const dataset of datasetsToMigrate) {
      const srcConn = await getStorageConnection(dataset.storageServerId);
      const tables = await copySchema(srcConn, dstConn, dataset.schemaName);
      await prisma.dataset.update({
        where: { id: dataset.id },
        data: { storageServerId: targetStorageServerId },
      });
      datasetResults.push({ datasetId: dataset.id, schema: dataset.schemaName, tables });
    }

    return ok({ datasetsMigrated: datasetResults.length, datasets: datasetResults });
  } catch (e) {
    return handleApiError(e);
  }
}
