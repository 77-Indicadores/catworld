import type { NextRequest } from "next/server";
import ExcelJS from "exceljs";
import { prisma } from "@/server/db";
import { resolveActor } from "@/server/auth/actor";
import { canAccess } from "@/server/auth/permissions";
import { ensureInternalPrincipal, executeReadOnly, grantSchema } from "@/server/azure/sql";
import { executePostgresReadOnly } from "@/server/connections/postgres";
import { ApiError, handleApiError } from "@/server/http";
import { quoteIdentifier } from "@/server/security/naming";
import { fmtCell } from "@/lib/fmt-cell";

const EXPORT_LIMIT = 500_000;
const BOM = "﻿";

function buildCsv(columns: string[], rows: Record<string, unknown>[]): Blob {
  const sep = ";";
  const lines: string[] = [columns.join(sep)];
  for (const row of rows) {
    lines.push(
      columns.map((col) => {
        const v = fmtCell(row[col]);
        if (v === null) return "";
        const s = String(v);
        return s.includes(sep) || s.includes('"') || s.includes("\n")
          ? `"${s.replaceAll('"', '""')}"` : s;
      }).join(sep),
    );
  }
  return new Blob([new TextEncoder().encode(BOM + lines.join("\r\n"))], { type: "text/csv; charset=utf-8" });
}

async function buildXlsx(tableName: string, columns: string[], rows: Record<string, unknown>[]): Promise<Blob> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(tableName.slice(0, 31));
  ws.columns = columns.map((col) => ({ header: col, key: col, width: Math.min(Math.max(col.length + 2, 10), 40) }));
  // Bold header
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE9EEF5" } };
  for (const row of rows) {
    ws.addRow(columns.map((col) => fmtCell(row[col])));
  }
  ws.autoFilter = { from: "A1", to: { row: 1, column: columns.length } };
  return new Blob([await wb.xlsx.writeBuffer()], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

function buildColumnsCsv(columns: { sqlName: string; originalName: string; sqlType: string; nullable: boolean }[]): Blob {
  const sep = ";";
  const header = ["Coluna SQL", "Nome original", "Tipo", "Nulável"].join(sep);
  const lines = columns.map((c) =>
    [c.sqlName, c.originalName, c.sqlType, c.nullable ? "Sim" : "Não"].join(sep),
  );
  return new Blob([new TextEncoder().encode(BOM + [header, ...lines].join("\r\n"))], { type: "text/csv; charset=utf-8" });
}

async function buildColumnsXlsx(tableName: string, columns: { sqlName: string; originalName: string; sqlType: string; nullable: boolean }[]): Promise<Blob> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Colunas");
  ws.columns = [
    { header: "Coluna SQL", key: "sqlName", width: 30 },
    { header: "Nome original", key: "originalName", width: 30 },
    { header: "Tipo", key: "sqlType", width: 20 },
    { header: "Nulável", key: "nullable", width: 12 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE9EEF5" } };
  for (const c of columns) {
    ws.addRow({ sqlName: c.sqlName, originalName: c.originalName, sqlType: c.sqlType, nullable: c.nullable ? "Sim" : "Não" });
  }
  ws.autoFilter = { from: "A1", to: { row: 1, column: 4 } };
  return new Blob([await wb.xlsx.writeBuffer()], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(request);
    const { id } = await params;
    const format = request.nextUrl.searchParams.get("format") ?? "csv"; // csv | xlsx
    const what = request.nextUrl.searchParams.get("what") ?? "data"; // data | columns

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

    // ── Export columns list ──────────────────────────────────────────────────
    if (what === "columns") {
      if (format === "xlsx") {
        const blob = await buildColumnsXlsx(table.name, table.columns);
        return new Response(blob, {
          headers: {
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="${safeName}_colunas_${dateStr}.xlsx"`,
          },
        });
      }
      const blob = buildColumnsCsv(table.columns);
      return new Response(blob, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${safeName}_colunas_${dateStr}.csv"`,
        },
      });
    }

    // ── Export data ──────────────────────────────────────────────────────────
    let rows: Record<string, unknown>[];
    let columnNames: string[];

    if (table.source?.mode === "live") {
      const source = table.source;
      if (source.sourceKind === "table" && (!source.sourceSchema || !source.sourceTable))
        throw new ApiError(400, "INVALID_SOURCE", "Fonte do tipo tabela sem schema/tabela configurados");
      const sql =
        source.sourceKind === "table"
          ? `SELECT * FROM "${source.sourceSchema}"."${source.sourceTable}"`
          : source.sourceSql!;
      const result = await executePostgresReadOnly(source.connection, sql, 120, EXPORT_LIMIT);
      rows = result.rows as Record<string, unknown>[];
      columnNames = result.columns;
    } else {
      await ensureInternalPrincipal(actor.principal, table.dataset.storageServerId);
      await grantSchema(actor.principal, table.dataset.schemaName, "READ", table.dataset.storageServerId);
      const result = await executeReadOnly(
        actor.principal,
        `SELECT * FROM ${quoteIdentifier(table.dataset.schemaName)}.${quoteIdentifier(table.sqlName)}`,
        600,
        EXPORT_LIMIT,
        [],
        0,
        600,
        table.dataset.storageServerId,
      );
      rows = result.rows as Record<string, unknown>[];
      columnNames = result.columns;
    }

    if (format === "xlsx") {
      const blob = await buildXlsx(table.name, columnNames, rows);
      return new Response(blob, {
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${safeName}_${dateStr}.xlsx"`,
        },
      });
    }

    const blob = buildCsv(columnNames, rows);
    return new Response(blob, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${safeName}_${dateStr}.csv"`,
      },
    });
  } catch (e) {
    return handleApiError(e);
  }
}
