/**
 * DELETE em lotes para a retenção (tabelas grandes como cw_audit_events): um único DELETE de 1,5M linhas levou 28,9 s numa
 * instrução só (docs/estudo-confiabilidade-dados.md, PER-11), segurando locks de linha, gerando um pico de WAL e correndo o risco de
 * estourar statement_timeout. Em lotes de `batch` linhas, cada um numa instrução curta.
 *
 * `table` e `where` são SEMPRE literais do código (nunca entrada de usuário); só os valores vão por parâmetro.
 */
import { prisma } from "@/server/db";

export async function deleteInBatches(
  table: "cw_audit_events" | "cw_jobs",
  where: string,
  params: unknown[],
  batch = 20_000,
  maxBatches = 500,
): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const n = await prisma.$executeRawUnsafe(
      `DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${where} LIMIT ${Math.max(1, Math.floor(batch))})`,
      ...params,
    );
    total += n;
    if (n < batch) break;
  }
  return total;
}
