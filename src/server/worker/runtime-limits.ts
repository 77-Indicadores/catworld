/**
 * Limites que o PROCESSO worker recebe do seu perfil (ver server/worker/profiles.ts) e que código de biblioteca
 * (ex.: parser DuckDB) consulta sem depender de variável de ambiente. Fora de um worker vale o padrão.
 */
export const DEFAULT_DUCKDB_MEMORY_LIMIT = "1GB";

let duckdbMemoryLimit = DEFAULT_DUCKDB_MEMORY_LIMIT;

export function setDuckdbMemoryLimit(limit: string): void {
  duckdbMemoryLimit = limit;
}

export function getDuckdbMemoryLimit(): string {
  return duckdbMemoryLimit;
}
