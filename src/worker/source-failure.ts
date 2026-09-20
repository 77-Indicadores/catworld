/**
 * A trava mútua de refreshDatasetSource lança 409 SOURCE_REFRESH_IN_PROGRESS quando OUTRA rodada da mesma fonte já está
 * "running". Essa falha é do JOB (que será reagendado), não da fonte: o dono da fonte é a rodada que está rodando, então o
 * `fail()` do worker NÃO pode gravar lastStatus/lastError/nextRefreshAt nela. Se gravasse "queued"/"failed", apagaria o
 * "running" e a trava (NOT_RUNNING) deixaria uma terceira rodada entrar na mesma tabela de stage.
 */
export function isSourceBusyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "SOURCE_REFRESH_IN_PROGRESS";
}
