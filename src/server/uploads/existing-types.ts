/**
 * Append/upsert/delta sobre uma tabela que JA existe: o tipo da coluna fisica manda.
 *
 * O tipo do arquivo e inferido a cada envio e, quando a convencao nao pode ser decidida pelos valores (todas as datas com dia <= 12;
 * decimais como 1.234), a coluna vira TEXTO (ambigua). Contra uma tabela tipada isso quebrava o append ("Tipos incompativeis") mesmo
 * quando a tabela ja tem DATE/DECIMAL e a carga anterior registrou a convencao. Aqui a coluna ambigua herda o tipo fisico e a
 * convencao da ultima carga (guardada no schemaJson da versao). Sem convencao conhecida: FALHA ALTO (nunca chuta dd/mm nem ponto/virgula).
 */
import { parseDecimalType } from "@/lib/decimal-type";
import type { ParsedColumn } from "./parser";
import { markNonRetryable } from "./non-retryable";

const isText = (t: string) => t.startsWith("NVARCHAR") || t === "TEXT" || t.startsWith("VARCHAR") || t.startsWith("CHAR");

export function resolveAgainstExisting(
  mapping: ParsedColumn[],
  existing: readonly { name: string; sqlType: string }[],
  prev: readonly ParsedColumn[] | null,
): ParsedColumn[] {
  const exByName = new Map(existing.map((e) => [e.name, e.sqlType]));
  const prevByName = new Map((prev ?? []).map((p) => [p.sqlName, p]));
  return mapping.map((c) => {
    const ex = exByName.get(c.sqlName);
    if (!ex || !isText(c.sqlType)) return c;
    const p = prevByName.get(c.sqlName);
    if (ex === "DATE" || ex === "DATETIME2") {
      if (!c.dateOrder && !c.dateAmbiguous) return c; // nao parece data: a checagem de compatibilidade recusa
      const order = c.dateOrder ?? p?.dateOrder;
      if (!order) {
        throw markNonRetryable(new Error(
          `A coluna "${c.sqlName}" da tabela existente é ${ex}, mas as datas do arquivo são ambíguas (dd/mm ou mm/dd) e a carga anterior não registrou a convenção. ` +
          `Use datas ISO (AAAA-MM-DD) ou inclua um dia maior que 12; nada foi gravado.`,
        ));
      }
      const { dateAmbiguous: _a, ...rest } = c;
      return { ...rest, sqlType: ex, dateOrder: order };
    }
    const dec = parseDecimalType(ex);
    if (dec) {
      if (!c.decimalSep && !c.decimalAmbiguous) return c;
      const sep = c.decimalSep ?? p?.decimalSep;
      if (!sep) {
        throw markNonRetryable(new Error(
          `A coluna "${c.sqlName}" da tabela existente é ${ex}, mas os números do arquivo são ambíguos (ex.: 1.234 pode ser 1234 ou 1,234) e a carga anterior não registrou o separador. ` +
          `Padronize o separador decimal no arquivo; nada foi gravado.`,
        ));
      }
      const { decimalAmbiguous: _b, ...rest } = c;
      // a precisao da coluna fisica e o teto: valor que nao cabe falha na conversao (ValueConversionError), nunca arredonda
      return { ...rest, sqlType: ex, decimalSep: sep, decimalDigits: dec.precision };
    }
    return c;
  });
}

/** Ultimo mapeamento (com as convencoes) gravado para a tabela; null se nao ha versao ou o JSON e invalido. */
export async function loadPrevMapping(
  prisma: { datasetVersion: { findFirst(args: unknown): Promise<{ schemaJson: string } | null> } },
  tableId: string | null | undefined,
): Promise<ParsedColumn[] | null> {
  if (!tableId) return null;
  const v = await prisma.datasetVersion.findFirst({ where: { tableId }, orderBy: { createdAt: "desc" }, select: { schemaJson: true } });
  if (!v) return null;
  try { const j = JSON.parse(v.schemaJson); return Array.isArray(j) ? j as ParsedColumn[] : null; } catch { return null; }
}
