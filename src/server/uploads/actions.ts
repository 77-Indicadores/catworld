import { extname } from "node:path";
import { z } from "zod";
import { prisma } from "@/server/db";
import { canAccess } from "@/server/auth/permissions";
import { ApiError } from "@/server/http";
import type { Actor } from "@/server/auth/actor";

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

const SMALL_CSV_THRESHOLD = 1_048_576;       // 1 MB — TDS path, no Azure SQL INSERT SELECT
const LARGE_FILE_THRESHOLD = 50 * 1_048_576; // 50 MB — parse em memoria (DuckDB) fica pesado
                                              // independente do modo; um replace de 200MB+ nao
                                              // pode furar o limite de heavy jobs so por nao usar
                                              // staging (ja causou OOM com varios em paralelo)

// XLSX e sempre lido inteiro em memoria via ExcelJS Workbook, sem streaming (ver nota
// em parser.ts sobre o bug do WorkbookReader) — CSV/TSV grande passa pelo DuckDB, que
// tem teto proprio (CATWORLD_DUCKDB_MEMORY_LIMIT). Producao mostrou um xlsx de 28MB
// consumindo +1GB de RSS num unico job (cw_job_metrics, ~35x o tamanho do arquivo) —
// bem abaixo do LARGE_FILE_THRESHOLD de 50MB acima, entao esses jobs nao eram
// gateados como heavy e varios rodavam em paralelo (concorrencia 5), estourando a
// memoria do host e derrubando o container ("exited" sem log de erro da aplicacao).
const XLSX_HEAVY_THRESHOLD = 10 * 1_048_576; // 10 MB — bem mais conservador que o CSV

function isXlsx(filename: string): boolean {
  return extname(filename).toLowerCase() === ".xlsx";
}

function importWeight(sizeBytes: bigint, mode: string, filename: string): number {
  const size = Number(sizeBytes);
  if (isXlsx(filename) && size > XLSX_HEAVY_THRESHOLD) return 2;
  if (size <= SMALL_CSV_THRESHOLD) return 1;
  if (size > LARGE_FILE_THRESHOLD) return 2; // arquivo grande: parse em memoria pesado, qualquer modo
  if (mode === "replace") return 1; // direct BULK INSERT to target, no INSERT SELECT
  return 2; // deltaReplace / append / upsert → staging + INSERT SELECT on Azure SQL
}

export async function queuePreviewUpload(id: string) {
  // PREVIEW_UPLOAD tambem pode ser pesado: XLSX e sempre lido inteiro em memoria
  // (ExcelJS Workbook, sem streaming) e CSV grande passa pelo DuckDB em memoria —
  // mesmo custo do IMPORT_UPLOAD. Sem isso, previews de arquivos grandes furavam
  // o limite de heavy jobs (weight sempre 0) e rodavam todos em paralelo.
  const upload = await prisma.upload.findUniqueOrThrow({ where: { id }, select: { sizeBytes: true, originalFilename: true } });
  const size = Number(upload.sizeBytes);
  const heavyThreshold = isXlsx(upload.originalFilename) ? XLSX_HEAVY_THRESHOLD : LARGE_FILE_THRESHOLD;
  const weight = size > heavyThreshold ? 2 : 0;
  const [, job] = await prisma.$transaction([
    prisma.upload.update({
      where: { id },
      data: { status: "QUEUED_PREVIEW", progress: 5, errorMessage: null },
    }),
    prisma.job.create({ data: { type: "PREVIEW_UPLOAD", uploadId: id, weight } }),
  ]);
  return job;
}

export async function queueImportUploadAuto(uploadId: string, mapping: z.infer<typeof confirmUploadSchema>["mapping"]) {
  const upload = await prisma.upload.findUniqueOrThrow({ where: { id: uploadId }, select: { datasetId: true, tableId: true, mode: true, keyColumn: true, sizeBytes: true, originalFilename: true } });
  if (!upload.datasetId) throw new Error("Upload sem dataset definido — não é possível auto-confirmar");
  const weight = importWeight(upload.sizeBytes, upload.mode, upload.originalFilename);
  const [, job] = await prisma.$transaction([
    prisma.upload.update({
      where: { id: uploadId },
      data: { mappingJson: JSON.stringify(mapping), status: "QUEUED_IMPORT", progress: 25, errorMessage: null },
    }),
    prisma.job.create({ data: { type: "IMPORT_UPLOAD", uploadId, maxAttempts: 5, weight } }),
  ]);
  return job;
}

export async function queueImportUpload(actor: Actor, id: string, input: z.infer<typeof confirmUploadSchema>) {
  const [dataset, upload] = await Promise.all([
    prisma.dataset.findUnique({ where: { id: input.datasetId } }),
    prisma.upload.findUniqueOrThrow({ where: { id }, select: { sizeBytes: true, originalFilename: true } }),
  ]);
  if (!dataset) throw new ApiError(404, "DATASET_NOT_FOUND", "Dataset não encontrado");
  if (!await canAccess(actor, "WRITE", dataset.projectId, dataset.id)) {
    throw new ApiError(403, "FORBIDDEN", "Permissão insuficiente para este dataset");
  }
  const weight = importWeight(upload.sizeBytes, input.mode, upload.originalFilename);

  const [, job] = await prisma.$transaction([
    prisma.upload.update({
      where: { id },
      data: {
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
    }),
    prisma.job.create({ data: { type: "IMPORT_UPLOAD", uploadId: id, maxAttempts: 5, weight } }),
  ]);
  return job;
}
