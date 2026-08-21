import type { NextRequest } from "next/server";
import { z } from "zod";
import sql from "mssql";
import { prisma } from "@/server/db";
import { getStoragePool } from "@/server/storage/pool";
import { resolveActor } from "@/server/auth/actor";
import { canAccess } from "@/server/auth/permissions";
import { sqlIdentifier, quoteIdentifier } from "@/server/security/naming";
import { ApiError, handleApiError } from "@/server/http";
import { env } from "@/server/env";

const inputSchema = z.object({
  filename: z.string().min(1).max(500),
  tableId: z.string().uuid().nullable().optional(),
});

function notCapable(reason: string) {
  return new Response(null, {
    status: 200,
    headers: { "X-CW-Capable": "false", "X-CW-Reason": reason },
  });
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

export async function POST(r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(r);
    const datasetId = (await params).id;
    const { filename, tableId } = inputSchema.parse(await r.json());

    if (!filename.toLowerCase().endsWith(".csv")) return notCapable("not-csv");
    if (!env().CATWORLD_AZURE_BLOB_CONNECTION_STRING) return notCapable("storage-unavailable");

    const dataset = await prisma.dataset.findUnique({ where: { id: datasetId } });
    if (!dataset) throw new ApiError(404, "DATASET_NOT_FOUND", "Dataset não encontrado");
    if (!await canAccess(actor, "READ", dataset.projectId, dataset.id)) return new Response("Forbidden", { status: 403 });

    let table = tableId
      ? await prisma.datasetTable.findFirst({
          where: { id: tableId, datasetId },
          include: { columns: { orderBy: { ordinal: "asc" } } },
        })
      : null;

    if (!table) {
      const previousUpload = await prisma.upload.findFirst({
        where: { datasetId, originalFilename: filename, status: "COMPLETED", tableId: { not: null } },
        orderBy: { updatedAt: "desc" },
        include: { table: { include: { columns: { orderBy: { ordinal: "asc" } } } } },
      });
      table = previousUpload?.table ?? null;
    }

    if (!table) {
      const expectedTableName = sqlIdentifier(filename.replace(/\.[^.]+$/, ""));
      table = await prisma.datasetTable.findUnique({
        where: { datasetId_sqlName: { datasetId, sqlName: expectedTableName } },
        include: { columns: { orderBy: { ordinal: "asc" } } },
      });
    }

    if (!table) return notCapable("first-upload");

    const pool = await getStoragePool(dataset.storageServerId);
    const schema = dataset.schemaName;
    const tableName = table.sqlName;
    const target = `${quoteIdentifier(schema)}.${quoteIdentifier(tableName)}`;

    const columnResult = await pool.request()
      .input("schema", sql.NVarChar, schema)
      .input("table", sql.NVarChar, tableName)
      .query(`
        SELECT c.name, ty.name type_name, c.precision, c.scale, c.is_nullable
        FROM sys.columns c
        JOIN sys.types ty ON c.user_type_id=ty.user_type_id
        WHERE c.object_id=OBJECT_ID(QUOTENAME(@schema)+'.'+QUOTENAME(@table))
        ORDER BY c.column_id
      `);

    const physicalColumns = columnResult.recordset as { name: string; type_name: string; precision: number; scale: number; is_nullable: boolean }[];
    if (!physicalColumns.length) return notCapable("no-table");
    if (!physicalColumns.some(c => c.name === "_cw_rh")) return notCapable("no-hash-col");

    const dataColumns = physicalColumns.filter(c => c.name !== "_cw_rh");
    const expected = table.columns.map(c => c.sqlName);
    const actual = dataColumns.map(c => c.name);
    const namesMatch = JSON.stringify(actual) === JSON.stringify(expected);
    const hasTypedColumn = table.columns.some(c => c.sqlType !== "NVARCHAR(MAX)");
    const typesMatch = dataColumns.every((c, i) => physicalTypeMatches(c, table.columns[i]!.sqlType) && c.is_nullable);
    if (!hasTypedColumn) return notCapable("schema-mismatch");
    if (!namesMatch || !typesMatch) return notCapable("schema-mismatch");

    const countResult = await pool.request().query(`SELECT COUNT_BIG(*) n FROM ${target}`);
    const rowCount = Number(countResult.recordset[0].n);
    const existingMapping = table.columns.map(c => ({
      originalName: c.originalName,
      sqlName: c.sqlName,
      sqlType: c.sqlType,
      nullable: c.nullable,
    }));

    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          const req = pool.request();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (req as any).stream = true;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (req as any).query(`SELECT [_cw_rh] FROM ${target} WHERE [_cw_rh] IS NOT NULL`);
          await new Promise<void>((resolve, reject) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (req as any).on("row", (row: Record<string, string>) => {
              const rh = row["_cw_rh"];
              if (rh) controller.enqueue(enc.encode(rh + "\n"));
            });
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (req as any).on("done", resolve);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (req as any).on("error", reject);
          });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-CW-Capable": "true",
        "X-CW-Table-Id": table.id,
        "X-CW-Row-Count": String(rowCount),
        "X-CW-Mapping": JSON.stringify(existingMapping),
      },
    });
  } catch (e) {
    return handleApiError(e);
  }
}
