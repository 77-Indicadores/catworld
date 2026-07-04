import type { NextRequest } from "next/server";
import { z } from "zod";
import sql from "mssql";
import { prisma } from "@/server/db";
import { sqlPool } from "@/server/azure/sql";
import { resolveActor } from "@/server/auth/actor";
import { canAccess } from "@/server/auth/permissions";
import { sqlIdentifier, quoteIdentifier } from "@/server/security/naming";
import { handleApiError } from "@/server/http";
import { env } from "@/server/env";

// Streams current _cw_rh hash values for a table so the SDK can compute delta client-side.
// Response body: newline-delimited MD5 hashes (one per row, no header).
// Headers: X-CW-Capable, X-CW-Table-Id, X-CW-Row-Count, X-CW-Mapping (JSON).
// Returns X-CW-Capable: false if delta is not supported for this table.
export async function POST(r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const a = await resolveActor(r);
    const datasetId = (await params).id;
    const { filename } = z.object({ filename: z.string().min(1).max(500) }).parse(await r.json());

    const notCapable = (reason?: string) =>
      new Response(null, { status: 200, headers: { "X-CW-Capable": "false", ...(reason ? { "X-CW-Reason": reason } : {}) } });

    // Phase 2 only works with blob storage (direct BULK INSERT path)
    if (!env().CATWORLD_AZURE_BLOB_CONNECTION_STRING) return notCapable("no-blob");

    const dataset = await prisma.dataset.findUniqueOrThrow({ where: { id: datasetId } });
    if (!await canAccess(a, "READ", dataset.projectId, dataset.id))
      return new Response("Forbidden", { status: 403 });

    const tableName = sqlIdentifier(filename.replace(/\.[^.]+$/, ""));
    const table = await prisma.datasetTable.findUnique({
      where: { datasetId_sqlName: { datasetId, sqlName: tableName } },
      include: { columns: { orderBy: { ordinal: "asc" } } },
    });
    if (!table) return notCapable("no-table");

    const pool = await sqlPool();
    const schema = dataset.schemaName;
    const target = `${quoteIdentifier(schema)}.${quoteIdentifier(tableName)}`;

    const hasDelta = await pool.request()
      .input("schema", sql.NVarChar, schema)
      .input("table", sql.NVarChar, tableName)
      .query("SELECT 1 ok FROM sys.columns WHERE object_id=OBJECT_ID(QUOTENAME(@schema)+'.'+QUOTENAME(@table)) AND name='_cw_rh'");
    if (!hasDelta.recordset.length) return notCapable("no-hash-col");

    const countResult = await pool.request().query(`SELECT COUNT_BIG(*) n FROM ${target}`);
    const rowCount = Number(countResult.recordset[0].n);
    const existingMapping = table.columns.map(c => ({
      originalName: c.originalName, sqlName: c.sqlName, sqlType: c.sqlType, nullable: c.nullable,
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
