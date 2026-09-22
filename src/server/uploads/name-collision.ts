/**
 * Aviso de colisão de nome (docs/estudo-confiabilidade-dados.md, achado de produção): `Obras.csv` e `obras.csv` viram a MESMA tabela
 * `obras` (o nome SQL ignora maiúsculas/acentos). Cada envio substitui o outro em silêncio e a tabela oscilava entre 214 e 390.402
 * linhas. Não bloqueia (pode ser intencional), mas o cliente é avisado na resposta do upload.
 */
import { extname } from "node:path";
import { prisma } from "@/server/db";
import { sqlIdentifier } from "@/server/security/naming";

const stem = (filename: string) => filename.slice(0, filename.length - extname(filename).length);

/** Texto do aviso, ou null se não há colisão. */
export async function tableNameCollisionWarning(datasetId: string, filename: string): Promise<string | null> {
  const tableName = sqlIdentifier(stem(filename));
  const table = await prisma.datasetTable.findUnique({ where: { datasetId_sqlName: { datasetId, sqlName: tableName } }, select: { id: true } });
  if (!table) return null;
  const last = await prisma.upload.findFirst({
    where: { tableId: table.id, status: "COMPLETED" },
    orderBy: { createdAt: "desc" },
    select: { originalFilename: true },
  });
  if (!last || last.originalFilename === filename) return null;
  if (sqlIdentifier(stem(last.originalFilename)) !== tableName) return null; // a tabela veio de outra origem (ex.: renomeada): não é o mesmo caso
  return `O arquivo "${filename}" será gravado na tabela "${tableName}", que já recebe "${last.originalFilename}": os dois nomes viram a mesma tabela e cada envio substitui o do outro. Use nomes distintos ou o mesmo nome sempre.`;
}
