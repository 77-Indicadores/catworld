import { z } from "zod";
import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { resolveActor } from "@/server/auth/actor";
import { canAccess } from "@/server/auth/permissions";
import { ApiError, handleApiError, ok } from "@/server/http";
import { assertDeleteDetection, assertValidCron, exposeSource, nextRefreshFromCron } from "@/server/connections/sources";
import { deleteDatasetSource } from "@/server/data/catalog";
import { queryColumns, tableColumns, type SourceColumn } from "@/server/connections/postgres";
import { queryColumnsMssql, tableColumnsMssql } from "@/server/connections/mssql";
import { resolveColumn, shouldResetDelta } from "@/server/connections/source-guards";
import { clearSourceOptions, getSourceOptions, setSourceOptions } from "@/server/connections/source-options";
import { audit } from "@/server/audit";

// (rotas do Next so podem exportar handlers HTTP: as funcoes auxiliares vivem em connections/source-guards)
async function sourceColumnsFor(source: {
  sourceKind: string; sourceSchema: string | null; sourceTable: string | null; sourceSql: string | null;
  connection: Parameters<typeof tableColumns>[0] & { provider: string };
}, sourceSql: string | null): Promise<SourceColumn[]> {
  const mssql = source.connection.provider === "mssql";
  if (source.sourceKind === "table") {
    return mssql ? tableColumnsMssql(source.connection, source.sourceSchema!, source.sourceTable!) : tableColumns(source.connection, source.sourceSchema!, source.sourceTable!);
  }
  return mssql ? queryColumnsMssql(source.connection, sourceSql!) : queryColumns(source.connection, sourceSql!);
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(request);
    const id = (await params).id;
    const source = await prisma.datasetSource.findUniqueOrThrow({
      where: { id },
      include: { connection: { select: { id: true, name: true, provider: true } }, dataset: { select: { projectId: true } } },
    });
    if (actor.role !== "ADMIN" && !await canAccess(actor, "READ", source.dataset.projectId, source.datasetId)) {
      throw new ApiError(403, "FORBIDDEN", "Sem permissão para ler esta fonte");
    }
    return ok({ ...exposeSource(source), options: await getSourceOptions(id) });
  } catch (e) {
    return handleApiError(e);
  }
}

const patchSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  mode: z.enum(["extract", "live"]).optional(),
  refreshCron: z.string().max(100).nullable().optional(),
  keyColumn: z.string().max(128).nullable().optional(),
  deltaColumn: z.string().max(128).nullable().optional(),
  sourceSql: z.string().min(1).nullable().optional(),
  reconciliationCron: z.string().max(100).nullable().optional(),
  sourceSqlReconciliation: z.string().min(1).nullable().optional(),
  detectDeletions: z.boolean().optional(),
  keysSql: z.string().min(1).nullable().optional(),
  keysMinIntervalMinutes: z.number().int().min(1).nullable().optional(),
  active: z.boolean().optional(),
  /** opcoes por fonte (guardadas em cw_system_settings, sem migracao): ver connections/source-options.ts */
  options: z.object({
    allowEmpty: z.boolean().optional(),
    maxDropPct: z.number().int().min(1).max(99).optional(),
    onInvalid: z.enum(["null", "fail"]).optional(),
  }).optional(),
});

async function authorise(request: NextRequest, id: string) {
  const actor = await resolveActor(request);
  const source = await prisma.datasetSource.findUniqueOrThrow({
    where: { id },
    select: { datasetId: true, sourceKind: true, mode: true, keyColumn: true, deltaColumn: true, sourceSql: true, sourceSchema: true, sourceTable: true, connection: true, reconciliationCron: true, sourceSqlReconciliation: true, detectDeletions: true, keysSql: true, keysMinIntervalMinutes: true, dataset: { select: { projectId: true } } },
  });
  if (actor.role !== "ADMIN" && !await canAccess(actor, "WRITE", source.dataset.projectId, source.datasetId)) {
    throw new ApiError(403, "FORBIDDEN", "Sem permissão para modificar esta fonte");
  }
  return { actor, source };
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = (await params).id;
    const { actor, source } = await authorise(request, id);
    const { options: optionsPatch, ...input } = patchSchema.parse(await request.json());

    assertValidCron(input.refreshCron, "refreshCron");
    assertValidCron(input.reconciliationCron, "reconciliationCron");
    const effectiveCron = input.mode === "live" ? null : input.refreshCron;
    const nextAt = effectiveCron !== undefined
      ? (effectiveCron ? nextRefreshFromCron(effectiveCron) : null)
      : undefined;

    const effectiveReconciliationCron = input.mode === "live" ? null : input.reconciliationCron;
    const effectiveReconciliationSql = input.sourceSqlReconciliation !== undefined ? input.sourceSqlReconciliation : source.sourceSqlReconciliation;
    // Valida contra o estado resultante (mesclado): PATCH {sourceSqlReconciliation:null}
    // com cron ja gravado tambem precisa falhar.
    const resultingMode = input.mode ?? source.mode;
    const resultingReconciliationCron = resultingMode === "live"
      ? null
      : (input.reconciliationCron !== undefined ? input.reconciliationCron : source.reconciliationCron);
    if (resultingReconciliationCron?.trim() && source.sourceKind === "query" && !effectiveReconciliationSql?.trim()) {
      throw new ApiError(400, "RECONCILIATION_SQL_REQUIRED", "Fontes por consulta exigem uma consulta de reconciliacao (sem filtro de data) para habilitar o cron de reconciliacao");
    }
    const nextReconciliationAt = effectiveReconciliationCron !== undefined
      ? (effectiveReconciliationCron ? nextRefreshFromCron(effectiveReconciliationCron) : null)
      : undefined;

    // Deteccao de exclusoes: valida contra o estado resultante (mesclado). PATCH null limpa.
    const resultingKeyColumn = input.keyColumn !== undefined ? input.keyColumn : source.keyColumn;
    const resultingDetect = input.detectDeletions !== undefined ? input.detectDeletions : source.detectDeletions;
    const resultingKeysSql = input.keysSql !== undefined ? input.keysSql?.trim() || null : source.keysSql;
    const resultingKeysInterval = input.keysMinIntervalMinutes !== undefined ? input.keysMinIntervalMinutes : source.keysMinIntervalMinutes;
    assertDeleteDetection({
      mode: resultingMode, sourceKind: source.sourceKind, keyColumn: resultingKeyColumn,
      detectDeletions: resultingDetect, keysSql: resultingKeysSql, keysMinIntervalMinutes: resultingKeysInterval,
    });
    // FON-08: valida que a coluna de chave/incremento existe na origem (nome original ou saneado) e zera a marca d'agua quando
    // algo que a define muda. Sem isso, trocar a coluna mantinha a marca da coluna antiga e a fonte pulava linhas para sempre.
    const resetDelta = shouldResetDelta(input, source);
    const newKey = input.keyColumn !== undefined && input.keyColumn !== source.keyColumn ? input.keyColumn : null;
    const newDelta = input.deltaColumn !== undefined && input.deltaColumn !== source.deltaColumn ? input.deltaColumn : null;
    if (resultingMode === "extract" && (newKey || (newDelta && source.sourceKind === "table"))) {
      const cols = await sourceColumnsFor(source, input.sourceSql !== undefined ? input.sourceSql : source.sourceSql);
      if (newKey && !resolveColumn(cols, newKey)) {
        throw new ApiError(400, "KEY_COLUMN_UNKNOWN", `Coluna-chave "${newKey}" nao existe na fonte (colunas: ${cols.map(c => c.originalName).join(", ")})`);
      }
      if (newDelta && source.sourceKind === "table" && !resolveColumn(cols, newDelta)) {
        throw new ApiError(400, "DELTA_COLUMN_UNKNOWN", `Coluna de incremento "${newDelta}" nao existe na fonte (colunas: ${cols.map(c => c.originalName).join(", ")})`);
      }
    }
    const { detectDeletions: _d, keysSql: _q, keysMinIntervalMinutes: _i, ...rest } = input;
    const detectionData = resultingMode === "live"
      ? { detectDeletions: false, keysSql: null, keysMinIntervalMinutes: null }
      : {
          ...(input.detectDeletions !== undefined ? { detectDeletions: input.detectDeletions } : {}),
          ...(input.keysSql !== undefined || input.detectDeletions === false ? { keysSql: resultingDetect && source.sourceKind === "query" ? resultingKeysSql : null } : {}),
          ...(input.keysMinIntervalMinutes !== undefined || input.detectDeletions === false ? { keysMinIntervalMinutes: resultingDetect ? resultingKeysInterval : null } : {}),
        };

    if (optionsPatch && Object.keys(optionsPatch).length) {
      await setSourceOptions(id, optionsPatch);
      await audit(actor, "SOURCE_OPTIONS_CHANGED", "dataset_source", id, { fields: Object.keys(optionsPatch) });
    }
    return ok(exposeSource(await prisma.datasetSource.update({
      where: { id },
      data: {
        ...rest,
        ...detectionData,
        ...(resetDelta ? { lastDeltaValue: null } : {}),
        ...(effectiveCron !== undefined ? { refreshCron: effectiveCron, nextRefreshAt: nextAt } : {}),
        ...(input.mode === "live" ? { refreshCron: null, nextRefreshAt: null } : {}),
        ...(effectiveReconciliationCron !== undefined ? { reconciliationCron: effectiveReconciliationCron, nextReconciliationAt } : {}),
        ...(input.mode === "live" ? { reconciliationCron: null, nextReconciliationAt: null } : {}),
      },
    })));
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = (await params).id;
    await authorise(request, id);
    await deleteDatasetSource(id);
    await clearSourceOptions(id);
    return ok({ deleted: true });
  } catch (e) {
    return handleApiError(e);
  }
}
