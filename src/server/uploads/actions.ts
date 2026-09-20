import { extname } from "node:path";
import { z } from "zod";
import { prisma } from "@/server/db";
import { canAccess } from "@/server/auth/permissions";
import { ApiError } from "@/server/http";
import type { Actor } from "@/server/auth/actor";
import { assertUploadWrite } from "./access";

const columnSchema = z.object({
  originalName: z.string(),
  sqlName: z.string(),
  sqlType: z.string(),
  nullable: z.boolean(),
});

export const confirmUploadSchema = z.object({
  datasetId: z.string().uuid(),
  tableId: z.string().uuid().nullable().optional(),
  mode: z.enum(["replace", "append", "upsert"]),
  keyColumn: z.string().nullable().optional(),
  mapping: z.array(columnSchema).min(1, "Mapeamento não pode estar vazio"),
  deltaToDelete: z.array(z.string().regex(/^[0-9a-f]{32}$/, "Hash inválido")).optional(),
});

// Princípio único de peso de job em todo o Catworld (mesmo conceito aplicado a
// SOURCE_REFRESH/DERIVED_REFRESH — ver isBoundedSourceRun em
// src/server/connections/sources.ts): bounded = volume de dados conhecido/limitado
// por construção, nunca gateado por max_heavy_jobs; unbounded = pode ser qualquer
// tamanho, gateado (weight 2). Pra upload, o tamanho do arquivo já é conhecido
// antes de rodar, então os limiares abaixo são a aplicação direta desse princípio
// — calibrados por incidentes reais de produção (não são números arbitrários).
const SMALL_CSV_THRESHOLD = 1_048_576;       // 1 MB — TDS path, no Azure SQL INSERT SELECT
const LARGE_FILE_THRESHOLD = 15 * 1_048_576; // 15 MB — parse em memoria (DuckDB) fica pesado
                                              // independente do modo; um replace de 200MB+ nao
                                              // pode furar o limite de heavy jobs so por nao usar
                                              // staging (ja causou OOM com varios em paralelo).
                                              // Baixado de 50MB pra 15MB em 2026-09-15: producao
                                              // mostrou varios CSVs de 15-19MB (abaixo do teto
                                              // antigo, logo weight<2, nao gateados por
                                              // maxHeavyJobs) rodando em paralelo — cada um com
                                              // seu proprio DuckDB (limite de memoria do DuckDB do perfil do worker,
                                              // default 1GB) — e o host foi a ~12GB de RSS
                                              // (cw_job_metrics mostrou varios desses jobs com
                                              // created_at no mesmo segundo, workers diferentes).

// XLSX e sempre lido inteiro em memoria via ExcelJS Workbook, sem streaming (ver nota
// em parser.ts sobre o bug do WorkbookReader) — CSV/TSV grande passa pelo DuckDB, que
// tem teto proprio (limite de memoria do DuckDB do perfil do worker). Producao mostrou um xlsx de 28MB
// consumindo +1GB de RSS num unico job (cw_job_metrics, ~35x o tamanho do arquivo) —
// bem abaixo do LARGE_FILE_THRESHOLD de 50MB acima, entao esses jobs nao eram
// gateados como heavy e varios rodavam em paralelo (concorrencia 5), estourando a
// memoria do host e derrubando o container ("exited" sem log de erro da aplicacao).
const XLSX_HEAVY_THRESHOLD = 10 * 1_048_576; // 10 MB — bem mais conservador que o CSV

// .xls e lido pelo mesmo caminho (ExcelJS/memoria inteira) que .xlsx — mesmo peso.
function isXlsx(filename: string): boolean {
  const ext = extname(filename).toLowerCase();
  return ext === ".xlsx" || ext === ".xls";
}

/** Estados de origem validos para cada transicao (409 INVALID_UPLOAD_STATE fora deles). */
export const FROM_UPLOADED = ["PENDING_UPLOAD", "FAILED"];
export const FROM_CONFIRM = ["PENDING_UPLOAD", "AWAITING_CONFIRMATION", "FAILED"];
export const FROM_RETRY = ["FAILED"];

export function assertUploadStatus(status: string, allowed: string[]) {
  if (!allowed.includes(status)) {
    throw new ApiError(409, "INVALID_UPLOAD_STATE", `Upload em status ${status} nao aceita esta operacao`);
  }
}

/** Garante que a tabela existe e pertence ao dataset (evita reescrever o catalogo de outro dataset). */
export async function assertTableInDataset(tableId: string | null | undefined, datasetId: string) {
  if (!tableId) return;
  const table = await prisma.datasetTable.findUnique({ where: { id: tableId }, select: { datasetId: true } });
  if (!table || table.datasetId !== datasetId) {
    throw new ApiError(404, "TABLE_NOT_FOUND", "Tabela não encontrada neste dataset");
  }
}

function importWeight(sizeBytes: bigint, mode: string, filename: string): number {
  const size = Number(sizeBytes);
  if (isXlsx(filename) && size > XLSX_HEAVY_THRESHOLD) return 2;
  if (size <= SMALL_CSV_THRESHOLD) return 1;
  if (size > LARGE_FILE_THRESHOLD) return 2; // arquivo grande: parse em memoria pesado, qualquer modo
  if (mode === "replace") return 1; // direct BULK INSERT to target, no INSERT SELECT
  return 2; // deltaReplace / append / upsert → staging + INSERT SELECT on Azure SQL
}

export async function queuePreviewUpload(id: string, from: string[] = FROM_UPLOADED) {
  // PREVIEW_UPLOAD tambem pode ser pesado: XLSX e sempre lido inteiro em memoria
  // (ExcelJS Workbook, sem streaming) e CSV grande passa pelo DuckDB em memoria —
  // mesmo custo do IMPORT_UPLOAD. Sem isso, previews de arquivos grandes furavam
  // o limite de heavy jobs (weight sempre 0) e rodavam todos em paralelo.
  const upload = await prisma.upload.findUniqueOrThrow({ where: { id }, select: { sizeBytes: true, originalFilename: true } });
  const size = Number(upload.sizeBytes);
  const heavyThreshold = isXlsx(upload.originalFilename) ? XLSX_HEAVY_THRESHOLD : LARGE_FILE_THRESHOLD;
  const weight = size > heavyThreshold ? 2 : 0;
  return guardedQueue(id, from, { status: "QUEUED_PREVIEW", progress: 5, errorMessage: null }, { type: "PREVIEW_UPLOAD", uploadId: id, weight });
}

/**
 * Transicao atomica: so muda o status se ainda estiver em um dos estados de origem (0 linhas = 409),
 * cancela jobs ativos anteriores do upload e cria o novo job — tudo na mesma transacao.
 */
async function guardedQueue(
  id: string,
  from: string[],
  data: Record<string, unknown>,
  job: { type: string; uploadId: string; weight: number; maxAttempts?: number },
) {
  return prisma.$transaction(async (tx) => {
    const res = await tx.upload.updateMany({ where: { id, status: { in: from as never[] } }, data: data as never });
    if (res.count === 0) {
      const cur = await tx.upload.findUnique({ where: { id }, select: { status: true } });
      if (!cur) throw new ApiError(404, "NOT_FOUND", "Upload não encontrado");
      assertUploadStatus(cur.status, from);
    }
    await tx.job.updateMany({ where: { uploadId: id, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "FAILED", lastError: "Superseded by retry" } });
    return tx.job.create({ data: job as never });
  });
}

export async function queueImportUploadAuto(uploadId: string, mapping: z.infer<typeof confirmUploadSchema>["mapping"], from: string[] = FROM_UPLOADED) {
  const upload = await prisma.upload.findUniqueOrThrow({ where: { id: uploadId }, select: { datasetId: true, tableId: true, mode: true, keyColumn: true, sizeBytes: true, originalFilename: true } });
  if (!upload.datasetId) throw new Error("Upload sem dataset definido — não é possível auto-confirmar");
  const weight = importWeight(upload.sizeBytes, upload.mode, upload.originalFilename);
  return guardedQueue(uploadId, from, { mappingJson: JSON.stringify(mapping), status: "QUEUED_IMPORT", progress: 25, errorMessage: null }, { type: "IMPORT_UPLOAD", uploadId, maxAttempts: 5, weight });
}

export async function queueImportUpload(actor: Actor, id: string, input: z.infer<typeof confirmUploadSchema>) {
  await assertUploadWrite(actor, id); // WRITE no dataset atual do upload (alem do dataset de destino abaixo)
  const [dataset, upload] = await Promise.all([
    prisma.dataset.findUnique({ where: { id: input.datasetId } }),
    prisma.upload.findUniqueOrThrow({ where: { id }, select: { sizeBytes: true, originalFilename: true, status: true } }),
  ]);
  if (!dataset) throw new ApiError(404, "DATASET_NOT_FOUND", "Dataset não encontrado");
  if (!await canAccess(actor, "WRITE", dataset.projectId, dataset.id)) {
    throw new ApiError(403, "FORBIDDEN", "Permissão insuficiente para este dataset");
  }
  assertUploadStatus(upload.status, FROM_CONFIRM);
  await assertTableInDataset(input.tableId, dataset.id);
  const weight = importWeight(upload.sizeBytes, input.mode, upload.originalFilename);

  return guardedQueue(
    id,
    FROM_CONFIRM,
    {
      datasetId: input.datasetId,
      tableId: input.tableId ?? null,
      mode: input.mode,
      keyColumn: input.keyColumn ?? null,
      mappingJson: JSON.stringify(input.mapping),
      deltaJson: input.deltaToDelete ? JSON.stringify(input.deltaToDelete) : null,
      status: "QUEUED_IMPORT",
      progress: 25,
      errorMessage: null,
    },
    { type: "IMPORT_UPLOAD", uploadId: id, maxAttempts: 5, weight },
  );
}
