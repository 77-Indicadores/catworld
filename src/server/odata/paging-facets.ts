/** Pedacos puros do endpoint OData (testaveis sem o handler): facetas do $metadata e paginacao honrando $top. */

/** Facetas do $metadata: sem Precision/Scale o Edm.Decimal (v4.0: Scale=0) e o DateTimeOffset (Precision=0) truncam no cliente. */
export function edmFacets(sqlType: string): string {
  const t = sqlType.toUpperCase().replace(/\(.*\)/, "").trim();
  if (t === "DECIMAL" || t === "NUMERIC") {
    const m = /\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)/.exec(sqlType);
    return m ? ` Precision="${m[1]}" Scale="${m[2] ?? "0"}"` : ` Scale="variable"`;
  }
  if (t === "MONEY") return ` Precision="19" Scale="4"`;
  if (t === "SMALLMONEY") return ` Precision="10" Scale="4"`;
  if (t === "DATETIME2" || t === "DATETIMEOFFSET" || t === "TIME") return ` Precision="6"`;
  if (t === "DATETIME") return ` Precision="3"`;
  return "";
}

export const MAX_PAGE = 10_000;

/** Lê $top/$skip: inteiro >= 0. Lança Error com a mensagem para o chamador transformar em 400. */
export function parseNonNegativeInt(raw: string | null, name: string, dflt: number): number {
  if (raw === null || raw.trim() === "") return dflt;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${name} precisa ser um inteiro >= 0`);
  return Math.min(Number(raw.trim()), Number.MAX_SAFE_INTEGER);
}

/**
 * Params da proxima pagina, ou null. Com `$top` explicito o TOTAL pedido e respeitado: o nextLink carrega o `$top`
 * RESTANTE e some quando o total foi entregue (antes `$top=5` devolvia 5 linhas + nextLink e o cliente lia a tabela toda).
 * Sem `$top`, e paginacao do servidor: continua enquanto a pagina vier cheia.
 */
export function nextPageParams(o: { top: number; wantedTop: number; topRequested: boolean; skip: number; returned: number }): { top: string; skip: string } | null {
  if (o.top === 0 || o.returned !== o.top) return null;
  const remaining = o.topRequested ? o.wantedTop - o.top : null;
  if (remaining !== null && remaining <= 0) return null;
  return { top: String(remaining ?? o.top), skip: String(o.skip + o.top) };
}
