import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { resolveActor } from "@/server/auth/actor";
import { canAccess } from "@/server/auth/permissions";
import { ensureInternalPrincipal, executeReadOnly, grantSchema } from "@/server/azure/sql";
import { executePostgresReadOnly } from "@/server/connections/postgres";
import { getStorageConnection } from "@/server/storage/connection";
import { ApiError, handleApiError, ok } from "@/server/http";
import { quoteIdentifier } from "@/server/security/naming";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(request);
    const table = await prisma.datasetTable.findUniqueOrThrow({
      where: { id: (await params).id },
      include: { dataset: true, source: { include: { connection: true } } },
    });
    if (!(await canAccess(actor, "READ", table.dataset.projectId, table.dataset.id)) && actor.role !== "ADMIN")
      throw new ApiError(403, "FORBIDDEN", "Sem acesso ao dataset");

    const limit = Math.min(Number(request.nextUrl.searchParams.get("limit") ?? 100), 1000);

    // Live source (PostgreSQL connection via DatasetSource)
    if (table.source?.mode === "live") {
      const source = table.source;
      const sql = source.sourceKind === "table"
        ? `SELECT * FROM "${source.sourceSchema}"."${source.sourceTable}"`
        : source.sourceSql!;
      const result = await executePostgresReadOnly(source.connection, sql, 30, limit);
      return ok(result.rows, { columns: result.columns, rowCount: result.rowCount, source: { id: source.id, mode: source.mode } });
    }

    // Roteia pelo provider do storage do dataset
    const conn = await getStorageConnection(table.dataset.storageServerId);
    if (conn.provider === "postgres") {
      // PG: consulta direta via storage connection (sem grants de schema — não aplicável ao PG)
      const rows = await conn.query<Record<string, unknown>>(
        `SELECT * FROM ${conn.q(table.dataset.schemaName)}.${conn.q(table.sqlName)} LIMIT ${limit}`,
      );
      const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];
      return ok(rows, { columns, rowCount: rows.length });
    }

    // MSSQL: grant de schema + query via executeReadOnly
    await ensureInternalPrincipal(actor.principal, table.dataset.storageServerId);
    await grantSchema(actor.principal, table.dataset.schemaName, "READ", table.dataset.storageServerId);
    const result = await executeReadOnly(
      actor.principal,
      `SELECT TOP ${limit} * FROM ${quoteIdentifier(table.dataset.schemaName)}.${quoteIdentifier(table.sqlName)}`,
      30, limit, [], 0, 120, table.dataset.storageServerId,
    );
    return ok(result.rows, { columns: result.columns, rowCount: result.rowCount });
  } catch (e) {
    return handleApiError(e);
  }
}
