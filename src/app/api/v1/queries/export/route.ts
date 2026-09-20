import type { NextRequest } from "next/server";
import ExcelJS from "exceljs";
import { z } from "zod";
import { resolveActor } from "@/server/auth/actor";
import { syncActorGrants } from "@/server/auth/sync-grants";
import { runStorageQuery } from "@/server/sql-contract/run";
import { resolveQueryScope } from "@/server/auth/permissions";
import { ApiError, handleApiError, isQueryTimeout, publicQueryErrorMessage, queryTimeoutError } from "@/server/http";
import { audit } from "@/server/audit";
import { acquireQuerySlot, releaseQuerySlot, checkRateLimit } from "@/server/query/protection";
import { csvField, xlsxCell } from "@/server/query/export-format";

export async function POST(r: NextRequest) {
  try {
    const actor = await resolveActor(r);
    checkRateLimit(actor.principal, "query");
    const input = z.object({
      sql: z.string().min(1).max(50000),
      format: z.enum(["csv", "xlsx"]),
      // "iso" (opt-in): datas em ISO-8601 no CSV. Padrao inalterado.
      dateFormat: z.enum(["iso"]).optional(),
      datasetId: z.string().uuid().optional(),
      projectId: z.string().uuid().optional(),
    }).parse(await r.json());

    // Acesso: antes esta rota nao conferia nada (no Postgres qualquer ator lia qualquer schema).
    const scope = await resolveQueryScope(actor, { datasetId: input.datasetId, projectId: input.projectId });
    const schemas = scope.datasets.map((d) => d.schemaName);
    const storageServerId = scope.datasets[0]?.storageServerId ?? null;
    const syncScope: { datasetIds?: string[]; projectIds?: string[] } | undefined =
      input.datasetId ? { datasetIds: [input.datasetId] } : input.projectId ? { projectIds: [input.projectId] } : undefined;

    await syncActorGrants(actor, syncScope);

    const LIMIT = 10000;
    acquireQuerySlot();
    let result;
    try {
      result = await runStorageQuery({ actor, accessible: scope.accessible, sql: input.sql, timeout: 120, limit: LIMIT, schemas, storageServerId, normalize: input.dateFormat === "iso" });
    } finally {
      releaseQuerySlot();
    }
    await audit(actor, "QUERY_EXECUTED", "query", undefined, { rowCount: result.rowCount, executionTimeMs: result.executionTimeMs, export: input.format });
    // O export nao pagina: mais linhas que o teto sao cortadas, e isso e sinalizado (cabecalhos e, no XLSX, uma aba de aviso).
    const truncHeaders: Record<string, string> = result.truncated ? { "x-result-truncated": "true", "x-row-limit": String(LIMIT), "access-control-expose-headers": "x-result-truncated, x-row-limit" } : {};

    if (input.format === "csv") {
      const lines = [result.columns.map((c) => csvField(c)).join(","), ...result.rows.map(row => result.columns.map(c => csvField(row[c], input.dateFormat === "iso")).join(","))];
      return new Response(`\uFEFF${lines.join("\r\n")}`, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=query.csv", ...truncHeaders } });
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Resultado");
    sheet.addRow(result.columns);
    for (const row of result.rows) sheet.addRow(result.columns.map(c => xlsxCell(row[c]) as ExcelJS.CellValue));
    sheet.getRow(1).font = { bold: true };
    if (result.truncated) workbook.addWorksheet("Aviso").addRow([`Resultado truncado em ${LIMIT} linhas: ha mais linhas. Use /queries com offset ou "stream": true.`]);
    const buffer = await workbook.xlsx.writeBuffer();
    return new Response(buffer, { headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": "attachment; filename=query.xlsx", ...truncHeaders } });
  } catch (e) {
    // Erro do banco (sintaxe, permissao, coluna...) e erro da CONSULTA do usuario: 400, como em /queries.
    if (!(e instanceof ApiError) && e instanceof Error && "code" in e) {
      if (isQueryTimeout(e)) return handleApiError(queryTimeoutError(120));
      return handleApiError(new ApiError(400, "QUERY_FAILED", publicQueryErrorMessage(e.message)));
    }
    return handleApiError(e);
  }
}
