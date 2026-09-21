/**
 * Cancelamento cooperativo de um import em andamento (docs/estudo-confiabilidade-dados.md, MOT-08).
 *
 * "Cancelar" marca o job como FAILED no banco, mas o processo que já está importando não sabia e terminava o trabalho (e publicava a
 * tabela) mesmo cancelado. O worker vigia o estado do job e, ao vê-lo cancelado, marca o token; os pontos de checagem do importer
 * (`lease.assert()`, antes do swap) lançam `JobCancelledError` e nada é publicado. AsyncLocalStorage evita passar o token por todas as
 * assinaturas.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type CancelToken = { cancelled: boolean };
const store = new AsyncLocalStorage<CancelToken>();

export class JobCancelledError extends Error {
  constructor() {
    super("Job cancelado durante a execução: o import foi interrompido antes de publicar e a tabela anterior foi mantida.");
    this.name = "JobCancelledError";
  }
}

export function runWithCancelToken<T>(token: CancelToken, fn: () => Promise<T>): Promise<T> {
  return store.run(token, fn);
}

/** Lança se o job em execução neste contexto foi cancelado; fora de um job (testes, scripts) não faz nada. */
export function assertNotCancelled(): void {
  if (store.getStore()?.cancelled) throw new JobCancelledError();
}

/** Vigia o estado do job e marca o token quando ele deixa de estar RUNNING (cancelado, recolocado na fila por outro executor). */
export function watchJobStatus(
  token: CancelToken,
  readStatus: () => Promise<string | null>,
  intervalMs = 10_000,
): () => void {
  const timer = setInterval(() => {
    void readStatus().then(
      (status) => { if (status !== "RUNNING") token.cancelled = true; },
      () => undefined, // erro de banco transitório: não cancela por engano
    );
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
