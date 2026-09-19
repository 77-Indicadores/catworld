import type { Actor } from "@/server/auth/actor";
import { assertDatasetAccess, hasAnyWriteGrant, visibleDatasetIds } from "@/server/auth/permissions";
import { prisma } from "@/server/db";
import { ApiError } from "@/server/http";

/**
 * Upload nao tem dono no banco: o escopo vem do dataset. Com dataset definido exige WRITE nele; sem dataset
 * (ainda nao atribuido) basta ter WRITE em algum lugar, como antes.
 */
export async function assertUploadWrite(actor: Actor, uploadId: string) {
  const upload = await prisma.upload.findUnique({ where: { id: uploadId }, select: { datasetId: true } });
  if (!upload) throw new ApiError(404, "NOT_FOUND", "Upload não encontrado");
  if (upload.datasetId) {
    const ds = await prisma.dataset.findUnique({ where: { id: upload.datasetId }, select: { id: true, projectId: true } });
    if (ds) return assertDatasetAccess(actor, "WRITE", ds);
  }
  if (!await hasAnyWriteGrant(actor)) throw new ApiError(403, "FORBIDDEN", "Permissão insuficiente");
}

/** Filtro Prisma das listagens: so uploads de datasets visiveis (+ os sem dataset, para quem escreve em algum lugar). */
export async function uploadVisibilityWhere(actor: Actor) {
  const ids = await visibleDatasetIds(actor);
  if (ids === null) return {};
  const or: object[] = [{ datasetId: { in: ids } }];
  if (await hasAnyWriteGrant(actor)) or.push({ datasetId: null });
  return { OR: or };
}

export async function assertUploadRead(actor: Actor, uploadId: string) {
  const where = await uploadVisibilityWhere(actor);
  const found = await prisma.upload.findFirst({ where: { id: uploadId, ...where }, select: { id: true } });
  if (!found) {
    const exists = await prisma.upload.findUnique({ where: { id: uploadId }, select: { id: true } });
    throw new ApiError(exists ? 403 : 404, exists ? "FORBIDDEN" : "NOT_FOUND", exists ? "Sem permissão neste upload" : "Upload não encontrado");
  }
}
