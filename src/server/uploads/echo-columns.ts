/**
 * Colunas internas "ecoadas": quem le uma tabela com `SELECT *` recebe `cw_synced_at`/`cw_deleted_at` e, ao reenviar o arquivo, elas
 * voltavam como colunas do usuario (`cw_synced_at_col`, `_col_2`...). A cada ciclo leitura -> reenvio a tabela ganhava 2 colunas
 * (visto em producao: hosts.csv com 6 colunas reais e 446 ecos, ate estourar o limite de linha do Postgres).
 *
 * No import, essas colunas sao DESCARTADAS (com aviso). Os parsers leem por POSICAO, entao o arquivo continua sendo lido com o
 * mapping completo (`withEchoColumns`); so a tabela e as linhas gravadas usam o mapping sem os ecos.
 */
import type { ParsedColumn } from "./parser";
import { markNonRetryable } from "./non-retryable";

const ECHO = /^cw_(synced|deleted)_at(_col(_\d+)?)?$/;

export type EchoColumn = { index: number; col: ParsedColumn };

export const isEchoColumn = (c: Pick<ParsedColumn, "originalName" | "sqlName">) =>
  ECHO.test(c.originalName.trim().toLowerCase()) || ECHO.test(c.sqlName.toLowerCase());

/** Separa os ecos (com a posicao no arquivo) do mapping que vira tabela. */
export function dropEchoColumns(mapping: ParsedColumn[]): { mapping: ParsedColumn[]; echo: EchoColumn[] } {
  const echo: EchoColumn[] = [];
  const kept: ParsedColumn[] = [];
  mapping.forEach((col, index) => (isEchoColumn(col) ? echo.push({ index, col }) : kept.push(col)));
  return { mapping: kept, echo };
}

/** Mapping para LER o arquivo: os ecos voltam na posicao original, com sqlName sintetico (a linha lida traz a chave, ninguem a grava). */
export function withEchoColumns(mapping: ParsedColumn[], echo: EchoColumn[]): ParsedColumn[] {
  if (!echo.length) return mapping;
  const out = [...mapping];
  for (const { index, col } of echo) out.splice(index, 0, { ...col, sqlName: `__cw_echo_${index}`, sqlType: "NVARCHAR(MAX)" });
  return out;
}

export function echoWarning(echo: EchoColumn[]): string | null {
  if (!echo.length) return null;
  const names = echo.map((e) => e.col.originalName);
  const shown = names.length > 6 ? `${names.slice(0, 6).join(", ")} e mais ${names.length - 6}` : names.join(", ");
  return `${echo.length} coluna(s) interna(s) do Catworld reenviada(s) no arquivo foram descartadas (${shown}). ` +
    "Elas vem de SELECT * numa tabela do Catworld: selecione as colunas explicitamente antes de reenviar.";
}

/**
 * "row is too big" (Postgres, 54000): mesmo depois do TOAST cada valor ocupa ate ~18 bytes NA linha, e a linha cabe em 8160 bytes.
 * Arquivo com centenas de colunas nao cabe. Erro claro e sem retentativa (o mesmo arquivo falharia de novo).
 */
export function wideRowError(e: unknown, columnCount?: number): Error | null {
  const msg = e instanceof Error ? e.message : String(e);
  if (!/^row is too big/i.test(msg)) return null;
  const cols = columnCount ? ` (${columnCount} colunas)` : "";
  return markNonRetryable(new Error(
    `O arquivo e largo demais para o Postgres${cols}: uma linha passa do limite de 8 KB por linha, mesmo com os valores grandes ` +
    "guardados fora da linha. Reduza o numero de colunas ou divida o arquivo em mais de uma tabela. " +
    `Detalhe do banco: ${msg}`,
  ));
}
