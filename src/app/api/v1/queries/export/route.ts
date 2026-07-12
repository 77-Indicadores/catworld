import type { NextRequest } from "next/server";
import ExcelJS from "exceljs";
import { z } from "zod";
import { resolveActor } from "@/server/auth/actor";
import { syncActorGrants } from "@/server/auth/sync-grants";
import { executeReadOnly } from "@/server/azure/sql";
import { ApiError, handleApiError } from "@/server/http";
import { prisma } from "@/server/db";

export async function POST(r: NextRequest) {
  try {
    const actor = await resolveActor(r);
    const input = z.object({
      sql: z.string().min(1).max(50000),
      format: z.enum(["csv", "xlsx"]),
      datasetId: z.string().uuid().optional(),
      projectId: z.string().uuid().optional(),
    }).parse(await r.json());

    let schemas: string[] = [];
    let syncScope: { datasetIds?: string[]; projectIds?: string[] } | undefined;
    if (input.datasetId) {
      const dataset = await prisma.dataset.findUnique({ where: { id: input.datasetId, active: true } });
      if (!dataset) throw new ApiError(404, "NOT_FOUND", "Dataset nao encontrado");
      schemas = [dataset.schemaName];
      syncScope = { datasetIds: [dataset.id] };
    } else if (input.projectId) {
      const datasets = await prisma.dataset.findMany({ where: { projectId: input.projectId, active: true } });
      if (!datasets.length) throw new ApiError(404, "NOT_FOUND", "Nenhum dataset encontrado para este projeto");
      schemas = datasets.map((d) => d.schemaName);
      syncScope = { projectIds: [input.projectId] };
    }

    await syncActorGrants(actor, syncScope);

    const result = await executeReadOnly(actor.principal, input.sql, 120, 10000, schemas);

    if (input.format === "csv") {
      const lines = [result.columns.map(csv).join(","), ...result.rows.map(row => result.columns.map(c => csv(row[c])).join(","))];
      return new Response(`\uFEFF${lines.join("\r\n")}`, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=query.csv" } });
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Resultado");
    sheet.addRow(result.columns);
    for (const row of result.rows) sheet.addRow(result.columns.map(c => row[c] as ExcelJS.CellValue));
    sheet.getRow(1).font = { bold: true };
    const buffer = await workbook.xlsx.writeBuffer();
    return new Response(buffer, { headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": "attachment; filename=query.xlsx" } });
  } catch (e) {
    return handleApiError(e);
  }
}

const csv = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
