/**
 * Cliente da API para a interface: desembrulha o envelope { data, meta, error } e transforma qualquer falha
 * (HTTP, rede, corpo invalido) em ApiClientError com mensagem em portugues e o que fazer. Nunca engole erro.
 */

export const ERROR_HINTS: Record<string, string> = {
  UNAUTHENTICATED: "Sua sessão expirou. Entre novamente.",
  INVALID_TOKEN: "Token inválido, expirado ou revogado.",
  FORBIDDEN: "Você não tem permissão para esta ação. Peça acesso a um administrador.",
  CONNECTION_FORBIDDEN: "Esta conexão não é usada pelo projeto. Peça a um administrador para usá-la ou para liberar o acesso.",
  SCHEMA_FORBIDDEN: "O SQL usa dados de um dataset que você não pode ler. Remova essa referência ou peça acesso.",
  INVALID_CRON: "A expressão de agendamento (cron) é inválida. Exemplo: 0 3 * * * roda todo dia às 03:00 UTC.",
  CONFLICT: "Já existe um registro com esses dados (por exemplo, esta tabela já tem uma fonte). Edite o existente.",
  VALIDATION_ERROR: "Alguns campos são inválidos. Revise o formulário.",
  INVALID_JSON: "A requisição não pôde ser lida. Recarregue a página e tente de novo.",
  RATE_LIMIT_EXCEEDED: "Muitas requisições em pouco tempo.",
  TOO_MANY_CONCURRENT_QUERIES: "O servidor está ocupado com outras consultas. Tente novamente em instantes.",
  QUERY_TIMEOUT: "A consulta demorou demais e foi interrompida. Filtre mais ou use TOP.",
  FILE_TOO_LARGE: "O arquivo excede o tamanho máximo permitido.",
  XLSX_TOO_LARGE: "Arquivos Excel grandes não são suportados. Exporte como CSV.",
  UNSUPPORTED_FORMAT: "Formato não suportado. Use CSV, XLSX ou XLS.",
  UNSAFE_SQL: "Só consultas de leitura (SELECT) são permitidas.",
  NOT_FOUND: "Não encontrado. Pode ter sido removido.",
  DATASET_NOT_FOUND: "Dataset não encontrado. Pode ter sido removido.",
  NETWORK: "Sem conexão com o servidor. Verifique sua rede e tente de novo.",
  INTERNAL_ERROR: "Erro interno do servidor.",
};

export class ApiClientError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
    public errorId?: string,
    public retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

/** Mensagem final para o usuario: dica em portugues do codigo (+ detalhe do servidor quando ajuda). */
export function friendlyMessage(code: string, serverMessage: string | undefined, extra: { errorId?: string; retryAfterSeconds?: number } = {}): string {
  const hint = ERROR_HINTS[code];
  let text = hint ?? serverMessage ?? "Não foi possível concluir a ação.";
  if (code === "RATE_LIMIT_EXCEEDED" && extra.retryAfterSeconds) text += ` Tente de novo em ${extra.retryAfterSeconds}s.`;
  if (code === "INTERNAL_ERROR" && extra.errorId) text += ` Informe o código ${extra.errorId} ao suporte.`;
  return text;
}

export function toApiClientError(status: number, body: unknown, retryAfterHeader?: string | null): ApiClientError {
  const err = (body as { error?: { code?: string; message?: string; details?: { errorId?: string; retryAfterSeconds?: number; issues?: { path: string; message: string }[] } } } | null)?.error;
  const code = err?.code ?? (status === 401 ? "UNAUTHENTICATED" : status === 403 ? "FORBIDDEN" : status === 429 ? "RATE_LIMIT_EXCEEDED" : status >= 500 ? "INTERNAL_ERROR" : "HTTP_ERROR");
  const retry = err?.details?.retryAfterSeconds ?? (retryAfterHeader ? Number(retryAfterHeader) || undefined : undefined);
  const errorId = err?.details?.errorId;
  let message = friendlyMessage(code, err?.message, { errorId, retryAfterSeconds: retry });
  const issues = err?.details?.issues;
  if (code === "VALIDATION_ERROR" && issues?.length) message += ` (${issues.slice(0, 3).map((i) => i.path || i.message).join(", ")})`;
  return new ApiClientError(status, code, message, err?.details, errorId, retry);
}

export type ApiResult<T> = { data: T; meta: Record<string, unknown> | null };

/** fetch + envelope. Lanca ApiClientError em qualquer falha (HTTP, rede, corpo invalido). */
export async function apiRequest<T = unknown>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new ApiClientError(0, "NETWORK", friendlyMessage("NETWORK", undefined));
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // corpo nao-JSON: trata pelo status
  }
  if (!response.ok) {
    if (response.status === 401 && typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
      window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
    }
    throw toApiClientError(response.status, body, response.headers.get("Retry-After"));
  }
  const envelope = body as { data?: T; meta?: Record<string, unknown> | null } | null;
  return { data: (envelope?.data ?? (body as T)) as T, meta: envelope?.meta ?? null };
}

/** Avisos nao bloqueantes do servidor (meta.warnings). */
export function warningsOf(meta: Record<string, unknown> | null | undefined): string[] {
  const w = meta?.warnings;
  return Array.isArray(w) ? w.filter((x): x is string => typeof x === "string") : [];
}

export function errorMessage(e: unknown): string {
  return e instanceof ApiClientError ? e.message : e instanceof Error ? e.message : "Não foi possível concluir a ação.";
}

/** Texto de erro a partir de um corpo de resposta já lido (telas que fazem fetch direto). */
export function apiErrorText(body: unknown, fallback: string, status = 400): string {
  const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
  if (!err) return fallback;
  if (!err.code || (!ERROR_HINTS[err.code] && !err.message)) return err.message ?? fallback;
  return toApiClientError(status, body).message;
}
