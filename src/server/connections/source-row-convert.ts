/**
 * Conversao de linhas de uma fonte para o texto do bulkInsert, aplicando as opcoes da fonte (M4, L3):
 *  - fonte LEGADA (sem registro de opcoes): valor irrepresentavel (infinity, data BC) vira NULL com aviso (comportamento antigo);
 *    decimal legado com ponto flutuante de mais de 15 digitos e arredondado com aviso (em vez de parar a sincronizacao);
 *  - fonte NOVA (`strict`/`onInvalid: "fail"`): qualquer valor que nao cabe FALHA a carga.
 */
import { SourceValueError, convertSourceValue } from "./source-values";
import type { SourceOptions } from "./source-options";

type Col = { originalName: string; sqlName: string; sqlType: string; legacyRound?: boolean };

export const invalidAsNull = (o: SourceOptions) => (o.onInvalid ?? (o.strict ? "fail" : "null")) === "null";

export function makeRowConverter(columns: Col[], options: SourceOptions) {
  const nulled = new Map<string, number>();
  const rounded = new Set<string>();
  const asNull = invalidAsNull(options);
  const legacyDecimals = !options.strict;
  const convertRow = (row: Record<string, unknown>): (string | null)[] => columns.map((c) => {
    const ctx = {
      column: c.sqlName,
      legacyRound: c.legacyRound || (legacyDecimals && c.sqlType.startsWith("DECIMAL")),
      onRounded: () => { rounded.add(c.sqlName); },
    };
    try {
      return convertSourceValue(row[c.originalName], c.sqlType, ctx);
    } catch (e) {
      if (asNull && e instanceof SourceValueError && e.code === "SOURCE_VALUE_UNREPRESENTABLE") {
        nulled.set(c.sqlName, (nulled.get(c.sqlName) ?? 0) + 1);
        return null;
      }
      throw e;
    }
  });
  /** Avisos acumulados (para `lastError`), vazio se nada foi alterado. */
  const notes = (): string[] => {
    const out: string[] = [];
    if (nulled.size) out.push(`INVALID_VALUES_NULLED: valores irrepresentaveis viraram NULL (${[...nulled].map(([c, n]) => `${c}: ${n}`).join(", ")}); defina onInvalid="fail" na fonte para parar a carga nesses casos`);
    if (rounded.size) out.push(`LEGACY_PRECISION: coluna(s) ${[...rounded].join(", ")} chegaram como ponto flutuante com mais de 15 digitos significativos e foram arredondadas (fonte legada); recrie a fonte para a regra estrita`);
    return out;
  };
  return { convertRow, notes };
}
