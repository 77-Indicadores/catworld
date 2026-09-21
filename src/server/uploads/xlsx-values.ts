/**
 * Valor de célula XLSX → texto (TIP-08, docs/estudo-confiabilidade-dados.md). Funções puras sobre o que o ExcelJS entrega.
 *
 * Regras (nada vira NULL nem "[object Object]"):
 *  - texto formatado (rich text) → texto concatenado; hiperlink → o texto exibido;
 *  - fórmula → o resultado calculado (número, texto, booleano, data em ISO UTC); fórmula SEM resultado calculado é ERRO nomeando a célula
 *    (o valor não existe no arquivo: gravar vazio seria inventar);
 *  - célula de erro (#N/A, #DIV/0!...) → o texto do erro, explícito (a coluna vira TEXT: o arquivo contém mesmo um erro naquela célula);
 *  - data → ISO 8601 em UTC (independe do fuso do servidor);
 *  - célula mesclada: só a célula mestre tem valor (as demais são vazias, em vez de repetir o valor da mestra);
 *  - linha totalmente vazia não é registro.
 */
import type ExcelJS from "exceljs";

export class XlsxValueError extends Error { constructor(message: string) { super(message); this.name = "XlsxValueError"; } }

export function cellValueText(value: unknown, address = "?"): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new XlsxValueError(`Célula ${address}: data inválida`);
    return value.toISOString();
  }
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (typeof v.error === "string") return v.error;
    if (Array.isArray(v.richText)) return (v.richText as { text?: string }[]).map((r) => r.text ?? "").join("");
    if ("formula" in v || "sharedFormula" in v) {
      if (v.result === undefined || v.result === null) {
        throw new XlsxValueError(`Célula ${address} tem uma fórmula sem valor calculado no arquivo. Abra e salve o arquivo no Excel (ou cole como valores) para o Catworld não gravar uma célula vazia no lugar.`);
      }
      return cellValueText(v.result, address);
    }
    if ("hyperlink" in v) return v.text !== undefined ? cellValueText(v.text, address) : String(v.hyperlink);
    if ("text" in v) return cellValueText(v.text, address);
  }
  throw new XlsxValueError(`Célula ${address}: tipo de valor não suportado (${Object.prototype.toString.call(value)})`);
}

/** Textos de uma linha (índice 0 = coluna A). Mescladas: só a célula mestre tem valor. */
export function rowTexts(row: ExcelJS.Row): string[] {
  const out: string[] = [];
  row.eachCell({ includeEmpty: true }, (cell, col) => {
    const master = (cell as { isMerged?: boolean; master?: ExcelJS.Cell }).isMerged ? (cell as { master?: ExcelJS.Cell }).master : undefined;
    if (master && master.address !== cell.address) { out[col - 1] = ""; return; }
    out[col - 1] = cellValueText(cell.value, cell.address);
  });
  for (let i = 0; i < out.length; i++) out[i] ??= "";
  return out;
}

export const isBlankRow = (texts: string[]) => texts.every((t) => t.trim() === "");
