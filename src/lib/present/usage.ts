/**
 * Como CONSUMIR uma tabela: nome SQL com schema, URL OData por tabela e exemplos do protocolo incremental (`since`).
 * Funções puras (as telas só exibem e copiam). Ver docs/table-contract.md e docs/query-contract.md.
 */

const PLACEHOLDER_ORIGIN = "https://SEU-CATWORLD";

export const TOKEN_PLACEHOLDER = "SEU_TOKEN";

export function normalizeOrigin(origin: string | null | undefined): string {
  const o = (origin ?? "").trim().replace(/\/+$/, "");
  return o || PLACEHOLDER_ORIGIN;
}

/** `ds_test.vendas` — o nome usado em T-SQL e no Power BI (SQL). */
export function qualifiedSqlName(schemaName: string, sqlName: string): string {
  return `${schemaName}.${sqlName}`;
}

export function sqlSelectExample(schemaName: string, sqlName: string): string {
  return `SELECT TOP 100 * FROM ${qualifiedSqlName(schemaName, sqlName)}`;
}

/** URL OData da tabela (Power BI > OData). A autenticação é por token (`api_key`) ou Basic/Bearer. */
export function odataTableUrl(origin: string | null | undefined, projectSlug: string, datasetSlug: string, sqlName: string): string {
  return `${normalizeOrigin(origin)}/api/odata/${projectSlug}/${datasetSlug}/${sqlName}`;
}

export function rowsUrl(origin: string | null | undefined, tableId: string): string {
  return `${normalizeOrigin(origin)}/api/v1/tables/${tableId}/rows`;
}

/** `since` só existe em tabela com fonte EXTRACT (na live a API responde SINCE_NOT_SUPPORTED). */
export function supportsSince(source: { mode: string } | null | undefined): boolean {
  return source?.mode === "extract";
}

export function sinceCurlExample(origin: string | null | undefined, tableId: string): string {
  return [
    `# 1ª chamada: baseline (a tabela até o limite)`,
    `curl -H "Authorization: Bearer ${TOKEN_PLACEHOLDER}" "${rowsUrl(origin, tableId)}?limit=1000"`,
    ``,
    `# depois: só o que mudou desde a última chamada (guarde meta.nextSince)`,
    `curl -H "Authorization: Bearer ${TOKEN_PLACEHOLDER}" "${rowsUrl(origin, tableId)}?since=<meta.nextSince>&limit=1000"`,
  ].join("\n");
}

export function sdkChangesExample(tableId: string): string {
  return [
    `from catworld import Client`,
    ``,
    `client = Client(base_url="<url-do-catworld>", token="${TOKEN_PLACEHOLDER}")`,
    `mudancas = client.changes("${tableId}", since=None)  # 1ª vez: baseline`,
    `# guarde mudancas["nextSince"] e use como since= na próxima chamada`,
    `# mudancas["rows"] = linhas alteradas; mudancas["removedKeys"] = chaves excluídas`,
  ].join("\n");
}
