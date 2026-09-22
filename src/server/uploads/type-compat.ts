/**
 * Compatibilidade de tipos no append/upsert sobre uma tabela que JÁ existe (docs/estudo-confiabilidade-dados.md, TIP-05/MOT-03).
 *
 * O tipo do arquivo é inferido a cada envio. Sem esta checagem, uma entrega em que todos os valores por acaso são inteiros
 * estreitava uma coluna DECIMAL para BIGINT (1,5 virava 2) e uma entrega só com datas estreitava DATETIME2 para DATE (a hora
 * sumia). Regra: só é aceito ALARGAR (o valor sempre cabe sem perder informação); estreitar exige um replace, que recria a tabela.
 */
import { parseDecimalType } from "@/lib/decimal-type";
import { markNonRetryable } from "./non-retryable";

const isText = (t: string) => t.startsWith("NVARCHAR") || t === "TEXT" || t.startsWith("VARCHAR") || t.startsWith("CHAR");

/** A coluna física `existing` recebe, sem perda, valores do tipo `incoming`? (tipos canônicos do Catworld) */
export function canonicalAccepts(existing: string, incoming: string): boolean {
  if (existing === incoming) return true;
  if (isText(existing)) return true;                       // texto guarda qualquer coisa, sem perda
  if (existing === "BIGINT") return false;                 // inteiro só recebe inteiro (igualdade acima)
  const ex = parseDecimalType(existing);
  if (ex) {
    if (incoming === "BIGINT") return true;                // o valor cabe ou o banco recusa em voz alta (overflow), nunca arredonda
    const inc = parseDecimalType(incoming);
    return !!inc && inc.scale <= ex.scale && inc.precision - inc.scale <= ex.precision - ex.scale;
  }
  if (existing === "DATETIME2") return incoming === "DATE";
  return false;                                            // DATE e TIME só recebem o mesmo tipo
}

/** Colunas cujo tipo do arquivo NÃO cabe na coluna existente (vazio = compatível). Compara por posição, como o nome. */
export function incompatibleColumns(
  existing: readonly { name: string; sqlType: string }[],
  incoming: readonly { sqlName: string; sqlType: string }[],
): { column: string; existing: string; incoming: string }[] {
  const out: { column: string; existing: string; incoming: string }[] = [];
  incoming.forEach((c, i) => {
    const e = existing[i];
    if (e && !canonicalAccepts(e.sqlType, c.sqlType)) out.push({ column: c.sqlName, existing: e.sqlType, incoming: c.sqlType });
  });
  return out;
}

export function incompatibleMessage(cols: { column: string; existing: string; incoming: string }[]): string {
  const list = cols.map((c) => `"${c.column}" é ${c.existing} e o arquivo traz ${c.incoming}`).join("; ");
  return `Tipos incompatíveis com a tabela existente: ${list}. O append/upsert não estreita colunas (perderia informação); use replace ou ajuste o arquivo.`;
}

/** Erro (nao repetivel pelo worker) de tipos incompativeis no append/upsert. */
export function incompatibleError(cols: { column: string; existing: string; incoming: string }[]): Error {
  return markNonRetryable(new Error(incompatibleMessage(cols)));
}

/** Tipo físico do SQL Server (sys.columns) → tipo canônico. */
export function mssqlPhysicalToCanonical(r: { type_name: string; precision?: number; scale?: number }): string {
  const t = r.type_name.toLowerCase();
  if (["bigint", "int", "smallint", "tinyint"].includes(t)) return "BIGINT";
  if (t === "decimal" || t === "numeric" || t === "money" || t === "smallmoney") return `DECIMAL(${r.precision ?? 18},${r.scale ?? 4})`;
  if (t === "date") return "DATE";
  if (["datetime2", "datetime", "smalldatetime"].includes(t)) return "DATETIME2";
  if (t === "time") return "TIME";
  if (["nvarchar", "varchar", "nchar", "char", "text", "ntext"].includes(t)) return "NVARCHAR(MAX)";
  // Outra familia (float, bit, uniqueidentifier, binario, xml...): tipo opaco que nao e igual a nenhum tipo do arquivo. Antes virava texto,
  // e texto aceita qualquer coisa: um append num FLOAT/BIT passava pela checagem.
  return `MSSQL:${t}`;
}
