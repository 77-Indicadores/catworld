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
 * RESTANTE e some quando o total foi entregue. Sem `$top` (paginacao do servidor) o nextLink leva SO o `$skip` (top=null):
 * se levasse `$top`, a pagina seguinte o leria como pedido do cliente e cortaria a tabela em 2 paginas.
 */
export function nextPageParams(o: { top: number; wantedTop: number; topRequested: boolean; skip: number; returned: number }): { top: string | null; skip: string } | null {
  if (o.top === 0 || o.returned !== o.top) return null;
  const skip = String(o.skip + o.top);
  if (!o.topRequested) return { top: null, skip };
  const remaining = o.wantedTop - o.top;
  if (remaining <= 0) return null;
  return { top: String(remaining), skip };
}

/** Colunas pedidas em `$select`, ou null (= todas). `*` = todas; `_row_number` (chave declarada no $metadata) e sempre devolvida e nao e coluna real. */
export function parseSelect(raw: string | null): string[] | null {
  if (!raw) return null;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.includes("*")) return null;
  return parts.filter((s) => s !== "_row_number");
}
