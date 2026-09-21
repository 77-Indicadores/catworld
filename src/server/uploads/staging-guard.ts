/**
 * Guarda contra "staging parcial" no import para SQL Server.
 *
 * O staging tem nome fixo por upload. Se uma tentativa morre no meio da carga (deploy, reinício do worker, timeout), a
 * próxima tentativa encontra o staging com parte das linhas. Confiar nele grava a tabela com MENOS linhas e marca o upload
 * COMPLETED (visto em produção: 50 mil, 300 mil, 600 mil e 650 mil linhas de um arquivo de 828.672, sempre na 2ª tentativa).
 *
 * O staging carrega o arquivo INTEIRO em todo modo (replace, append, upsert), exceto quando o SDK já mandou só a diferença (`phase2`, deltaJson):
 * aí ele guarda apenas as linhas novas/alteradas e não dá para comparar com a contagem do arquivo.
 * (Antes, a guarda excluía o replace por diferença "deltaReplace" — justamente o caminho de tabelas com `_cw_rh`,
 * como a vendas_completo — e nunca via o staging parcial.)
 */
export function stagingHoldsWholeFile(input: { mode: string; targetExists: boolean; phase2: boolean }): boolean {
  // replace, append e upsert (em tabela nova ou existente): o staging é o arquivo inteiro. Só o phase2 é diferente.
  return !input.phase2;
}

/** Staging com linhas, mas menos que o arquivo: descartar e recarregar do zero. */
export function isStagingPartial(input: { stagingRowCount: number; knownRowCount: number; mode: string; targetExists: boolean; phase2: boolean }): boolean {
  return input.stagingRowCount > 0
    && input.knownRowCount > 0
    && input.stagingRowCount < input.knownRowCount
    && stagingHoldsWholeFile(input);
}
