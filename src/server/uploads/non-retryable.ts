/**
 * Erro deterministico: repetir o job com o mesmo arquivo/tabela falharia igual (integridade, conversao de valor, tipo incompativel).
 * O worker le `nonRetryable` em fail() e vai direto para FAILED, sem gastar as tentativas nem atrasar o aviso ao usuario.
 */
export type NonRetryable = { nonRetryable: true };

export function markNonRetryable<E extends Error>(e: E): E & NonRetryable {
  (e as E & NonRetryable).nonRetryable = true;
  return e as E & NonRetryable;
}

export function isNonRetryable(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { nonRetryable?: unknown }).nonRetryable === true;
}
