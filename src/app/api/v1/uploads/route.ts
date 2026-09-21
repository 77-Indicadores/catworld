import type { NextRequest } from "next/server";
import { tableNameCollisionWarning } from "@/server/uploads/name-collision";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { z } from "zod";
import { resolveActor } from "@/server/auth/actor";
import { assertDatasetAccess, hasAnyWriteGrant } from "@/server/auth/permissions";
import { prisma } from "@/server/db";
import { getUploadLimits } from "@/server/worker/config";
import { actorLabel } from "@/server/auth/actor-label";
import { ApiError, handleApiError, ok } from "@/server/http";
import { uploadVisibilityWhere } from "@/server/uploads/access";
import { assertTableInDataset } from "@/server/uploads/actions";
import { uploadTarget } from "@/server/storage";
import { normalizeTypeOverride } from "@/server/uploads/type-override";
import { checkRateLimit } from "@/server/query/protection";

export async function GET(r: NextRequest) {
  try {
    const actor = await resolveActor(r);
    return ok(
      await prisma.upload.findMany({
        where: await uploadVisibilityWhere(actor),
        take: 100,
        orderBy: { createdAt: "desc" },
        include: { dataset: true, table: true },
      }),
    );
  } catch (e) {
    return handleApiError(e);
  }
}

export async function POST(r: NextRequest) {
  try {
    const actor = await resolveActor(r);
    if (!await hasAnyWriteGrant(actor)) throw new ApiError(403, "FORBIDDEN", "Permissao insuficiente");
    checkRateLimit(actor.principal, "upload");

    const input = z.object({
      filename: z.string().min(1).max(500),
      sizeBytes: z.number().int().positive(),
      fileHash: z.string().length(32).optional(),
      datasetId: z.string().uuid().optional(),
      tableId: z.string().uuid().optional(),
      mode: z.enum(["replace", "append", "upsert"]).default("replace"),
      keyColumn: z.string().optional(),
      // Só relevante com mode="upsert": indica que o arquivo é 100% do estado atual da
      // origem (não um lote parcial) — habilita detecção de exclusão (linhas ausentes do
      // arquivo são marcadas como excluídas). Default false preserva o comportamento
      // atual (upsert parcial, sem inferir exclusão).
      fullSnapshot: z.boolean().optional(),
      previewJson: z.string().optional(),
      mappingJson: z.string().optional(),
      rowCount: z.number().int().nonnegative().optional(),
      // Sobrepõe o tipo SQL auto-detectado pra colunas especificas (chave = sqlName
      // normalizado do cabeçalho, valor = um dos tipos canonicos aceitos em
      // applyTypeOverrides). Aplicado durante PREVIEW_UPLOAD, antes do import —
      // ver src/worker/index.ts.
      typeOverrides: z.record(z.string(), z.string().refine((t) => normalizeTypeOverride(t) !== null, "tipo de override inválido (use BIGINT, DECIMAL(p,s) com p<=38, DATE, DATETIME2, TIME ou NVARCHAR(MAX))")).optional(),
    }).parse(await r.json());

    const limits = await getUploadLimits();
    if (input.sizeBytes > limits.maxBytes) {
      throw new ApiError(413, "FILE_TOO_LARGE", "Arquivo excede o limite configurado");
    }
    const ext = extname(input.filename).toLowerCase();
    if (![".csv", ".xlsx", ".xls"].includes(ext)) {
      throw new ApiError(400, "UNSUPPORTED_FORMAT", "Use CSV, XLSX ou XLS");
    }
    // XLSX/XLS sao lidos inteiros em memoria (ExcelJS, sem streaming) tanto no preview
    // quanto no import — um arquivo grande pode estourar a memoria do worker sozinho,
    // mesmo com o limite de concorrencia de heavy jobs. CSV nao tem essa restricao
    // (100% streamed via DuckDB/csv-parse).
    if ((ext === ".xlsx" || ext === ".xls") && input.sizeBytes > limits.xlsxMaxBytes) {
      const maxMb = Math.round(limits.xlsxMaxBytes / (1024 * 1024));
      throw new ApiError(413, "XLSX_TOO_LARGE", `Arquivos XLSX/XLS acima de ${maxMb}MB nao sao suportados (lidos inteiros em memoria) — exporte como CSV.`);
    }

    if (input.datasetId) {
      const ds = await prisma.dataset.findUnique({ where: { id: input.datasetId }, select: { id: true, projectId: true } });
      if (!ds) throw new ApiError(404, "DATASET_NOT_FOUND", "Dataset não encontrado");
      await assertDatasetAccess(actor, "WRITE", ds);
    }
    if (input.tableId) {
      if (!input.datasetId) throw new ApiError(400, "VALIDATION_ERROR", "tableId exige datasetId");
      await assertTableInDataset(input.tableId, input.datasetId);
    }
    const blobName = `uploads/${new Date().toISOString().slice(0, 10)}/${randomUUID()}${extname(input.filename).toLowerCase()}`;
    const upload = await prisma.upload.create({
      data: {
        originalFilename: input.filename,
        blobName,
        sizeBytes: BigInt(input.sizeBytes),
        fileHash: input.fileHash ?? null,
        datasetId: input.datasetId ?? null,
        tableId: input.tableId ?? null,
        mode: input.mode,
        keyColumn: input.keyColumn ?? null,
        fullSnapshot: input.fullSnapshot ?? false,
        previewJson: input.previewJson ?? null,
        mappingJson: input.mappingJson ?? null,
        typeOverridesJson: input.typeOverrides ? JSON.stringify(input.typeOverrides) : null,
        rowCount: input.rowCount != null ? BigInt(input.rowCount) : null,
        createdBy: await actorLabel(actor),
      },
    });

    // Colisão de nome (Obras.csv x obras.csv = mesma tabela): não bloqueia, mas o cliente é avisado.
    const collision = input.datasetId && !input.tableId ? await tableNameCollisionWarning(input.datasetId, input.filename).catch(() => null) : null;
    return ok({ upload, sas: await uploadTarget(upload.id) }, collision ? { warnings: [collision] } : undefined, 201);
  } catch (e) {
    return handleApiError(e);
  }
}
