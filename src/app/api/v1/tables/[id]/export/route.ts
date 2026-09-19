import type { NextRequest } from "next/server";
import sql from "mssql";
import { prisma } from "@/server/db";
import { resolveActor } from "@/server/auth/actor";
import { canAccess } from "@/server/auth/permissions";
import { ensureInternalPrincipal, grantSchema } from "@/server/azure/sql";
import { executeLiveReadOnly, liveQuotedTable, type LiveConnection } from "@/server/connections/live";
import { getStorageConnection } from "@/server/storage/connection";
import type { PgStorageConnection } from "@/server/storage/pg-storage";
import type { MssqlStorageConnection } from "@/server/storage/mssql-storage";
import { ApiError, handleApiError } from "@/server/http";
import { fmtCell } from "@/lib/fmt-cell";
import { mssqlKind, normalizeRows, pgKind, type ColumnKind } from "@/server/sql-contract/result";

const BOM = "﻿";
const SEP = ";";

// ── CSV helpers ───────────────────────────────────────────────────────────────

function csvLine(values: unknown[], isoDates = false): string {
  return values
    .map((v) => {
      const cell = fmtCell(v, isoDates);
      if (cell === null) return "";
      const s = String(cell);
      return s.includes(SEP) || s.includes('"') || s.includes("\n")
        ? `"${s.replaceAll('"', '""')}"` : s;
    })
    .join(SEP);
}

// ── Streaming CSV for storage tables ─────────────────────────────────────────

async function streamStorageCsv(
  storageConn: PgStorageConnection | MssqlStorageConnection,
  schema: string,
  table: string,
  columns: string[],
  isoDates = false,
): Promise<ReadableStream<Uint8Array>> {
  const enc = new TextEncoder();

  if (storageConn.provider === "postgres") {
    const pg = storageConn as PgStorageConnection;
    const quotedTable = `"${schema.replace(/"/g, '""')}"."${table.replace(/"/g, '""')}"`;
    return new ReadableStream<Uint8Array>({
      async start(ctrl) {
        let client: import("pg").PoolClient | null = null;
        try {
          ctrl.enqueue(enc.encode(BOM + csvLine(columns) + "\r\n"));
          client = await pg._pool.connect();
          await client.query("SET statement_timeout = 3600000"); // 1 h
          const PAGE = 5_000;
          let offset = 0;
          while (true) {
            const result = await client.query(
              `SELECT * FROM ${quotedTable} LIMIT ${PAGE} OFFSET ${offset}`,
            );
            if (result.rows.length === 0) break;
            // dateFormat=iso: DATE/TIME/bigint/decimal pelo tipo da coluna (sem isso DATE sai deslocada por fuso)
            const kinds: Record<string, ColumnKind> = isoDates
              ? Object.fromEntries(result.fields.map((f) => [f.name, pgKind(f.dataTypeID)]))
              : {};
            if (isoDates) normalizeRows(result.rows as Record<string, unknown>[], kinds, "pg");
            const chunk = (result.rows as Record<string, unknown>[])
              .map((row) => csvLine(columns.map((c) => row[c]), isoDates))
              .join("\r\n") + "\r\n";
            ctrl.enqueue(enc.encode(chunk));
            if (result.rows.length < PAGE) break;
            offset += PAGE;
          }
          ctrl.close();
        } catch (err) {
          ctrl.error(err);
        } finally {
          client?.release();
        }
      },
    });
  }

  // MSSQL: event-based streaming
  const mssql = storageConn as MssqlStorageConnection;
  const quotedTable = `[${schema.replace(/]/g, "]]")}].[${table.replace(/]/g, "]]")}]`;
  return new ReadableStream<Uint8Array>({
    async start(ctrl) {
      const pool = await mssql.rawPool();
      const request = new sql.Request(pool);
      request.stream = true;

      ctrl.enqueue(enc.encode(BOM + csvLine(columns) + "\r\n"));

      const BATCH = 1_000;
      let batch: unknown[][] = [];

      function flush() {
        if (batch.length === 0) return;
        ctrl.enqueue(enc.encode(batch.map((vals) => csvLine(vals, isoDates)).join("\r\n") + "\r\n"));
        batch = [];
      }

      let kinds: Record<string, ColumnKind> = {};
      request.on("recordset", (cols: Record<string, { type?: { declaration?: string } }>) => {
        if (isoDates) kinds = Object.fromEntries(Object.entries(cols).map(([n, c]) => [n, mssqlKind(c.type?.declaration)]));
      });
      request.on("row", (row: Record<string, unknown>) => {
        if (isoDates) normalizeRows([row], kinds, "mssql");
        batch.push(columns.map((c) => row[c]));
        if (batch.length >= BATCH) flush();
      });
      request.on("error", (err: Error) => ctrl.error(err));
      request.on("done", () => { flush(); ctrl.close(); });

      request.query(`SELECT * FROM ${quotedTable}`);
    },
  });
}

// ── Columns CSV ───────────────────────────────────────────────────────────────

function buildColumnsCsv(
  cols: { sqlName: string; originalName: string; sqlType: string; nullable: boolean }[],
): Blob {
  const header = ["Coluna SQL", "Nome original", "Tipo", "Nulável"].join(SEP);
  const lines = cols.map((c) =>
    [c.sqlName, c.originalName, c.sqlType, c.nullable ? "Sim" : "Não"].join(SEP),
  );
  return new Blob([new TextEncoder().encode(BOM + [header, ...lines].join("\r\n"))], {
    type: "text/csv; charset=utf-8",
  });
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(request);
    const { id } = await params;
    const what = request.nextUrl.searchParams.get("what") ?? "data"; // data | columns
    // dateFormat=iso (opt-in): datas em ISO-8601 no CSV. Padrao inalterado.
    const isoDates = request.nextUrl.searchParams.get("dateFormat") === "iso";

    const table = await prisma.datasetTable.findUniqueOrThrow({
      where: { id },
      include: {
        dataset: true,
        source: { include: { connection: true } },
        columns: { orderBy: { ordinal: "asc" } },
      },
    });

    if (!(await canAccess(actor, "READ", table.dataset.projectId, table.dataset.id)) && actor.role !== "ADMIN")
      throw new ApiError(403, "FORBIDDEN", "Sem acesso ao dataset");

    const safeName = table.name.replace(/[^a-z0-9_\-]/gi, "_");
    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `${safeName}_${what === "columns" ? "colunas_" : ""}${dateStr}.csv`;
    const csvHeaders = {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Transfer-Encoding": "chunked",
      "X-Accel-Buffering": "no",
    };

    // ── Export columns list ──────────────────────────────────────────────────
    if (what === "columns") {
      return new Response(buildColumnsCsv(table.columns), { headers: csvHeaders });
    }

    // ── Export data ──────────────────────────────────────────────────────────
    const enc = new TextEncoder();

    // Live source — PostgreSQL connection
    if (table.source?.mode === "live") {
      const source = table.source;
      if (source.sourceKind === "table" && (!source.sourceSchema || !source.sourceTable))
        throw new ApiError(400, "INVALID_SOURCE", "Fonte do tipo tabela sem schema/tabela configurados");
      const querySql =
        source.sourceKind === "table"
          ? `SELECT * FROM ${liveQuotedTable(source.connection, source.sourceSchema!, source.sourceTable!)}`
          : source.sourceSql!;
      const result = await executeLiveReadOnly(source.connection as LiveConnection, querySql, 120, 500_000, 0, isoDates);
      const rows = result.rows as Record<string, unknown>[];
      const body = enc.encode(
        BOM + [csvLine(result.columns), ...rows.map((r) => csvLine(result.columns.map((c) => r[c]), isoDates))].join("\r\n"),
      );
      return new Response(body, { headers: csvHeaders });
    }

    // Storage-backed table — fully streamed
    const storageConn = await getStorageConnection(table.dataset.storageServerId);

    const csvColumns =
      table.columns.length > 0
        ? table.columns.map((c) => c.sqlName)
        : (() => { throw new ApiError(500, "NO_COLUMNS", "Tabela sem colunas registradas"); })();

    if (storageConn.provider !== "postgres") {
      await ensureInternalPrincipal(actor.principal, table.dataset.storageServerId);
      await grantSchema(actor.principal, table.dataset.schemaName, "READ", table.dataset.storageServerId);
    }

    const csvStream = await streamStorageCsv(
      storageConn as PgStorageConnection | MssqlStorageConnection,
      table.dataset.schemaName,
      table.sqlName,
      csvColumns,
      isoDates,
    );

    return new Response(csvStream, { headers: csvHeaders });
  } catch (e) {
    return handleApiError(e);
  }
}
