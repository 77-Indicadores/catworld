import { describe, expect, it } from "vitest";
import { dropEchoColumns, echoWarning, isEchoColumn, wideRowError, withEchoColumns } from "./echo-columns";
import { isNonRetryable } from "./non-retryable";
import type { ParsedColumn } from "./parser";

const col = (originalName: string, sqlName = originalName): ParsedColumn => ({ originalName, sqlName, sqlType: "NVARCHAR(MAX)", nullable: true });

// Forma real do hosts.csv: colunas do usuario + ecos de ciclos anteriores (SELECT * -> reenvio)
const file = [
  col("nome"), col("host"),
  col("cw_synced_at", "cw_synced_at_col"), col("cw_deleted_at", "cw_deleted_at_col"),
  col("porta"),
  col("cw_synced_at_col_2"), col("CW_DELETED_AT_COL_2", "cw_deleted_at_col_2"),
];

describe("colunas internas ecoadas no upload", () => {
  it("reconhece os ecos e so eles", () => {
    expect(file.filter(isEchoColumn).map((c) => c.sqlName)).toEqual(["cw_synced_at_col", "cw_deleted_at_col", "cw_synced_at_col_2", "cw_deleted_at_col_2"]);
    expect(isEchoColumn(col("cw_synced_at_coluna"))).toBe(false);
    expect(isEchoColumn(col("data_cw_synced_at"))).toBe(false);
  });

  it("descarta da tabela e devolve ao arquivo na posicao original (leitura posicional nao desalinha)", () => {
    const { mapping, echo } = dropEchoColumns(file);
    expect(mapping.map((c) => c.sqlName)).toEqual(["nome", "host", "porta"]);
    const read = withEchoColumns(mapping, echo);
    expect(read.map((c) => c.originalName)).toEqual(file.map((c) => c.originalName));
    // a linha lida por posicao: "porta" continua na 5a coluna do arquivo
    const row = ["a", "b", "x", "y", "22", "z", "w"];
    const obj = Object.fromEntries(read.map((c, i) => [c.sqlName, row[i]]));
    expect(mapping.map((c) => obj[c.sqlName])).toEqual(["a", "b", "22"]);
  });

  it("sem ecos: nada muda e sem aviso", () => {
    const plain = [col("a"), col("b")];
    const { mapping, echo } = dropEchoColumns(plain);
    expect(mapping).toEqual(plain);
    expect(withEchoColumns(mapping, echo)).toBe(mapping);
    expect(echoWarning(echo)).toBeNull();
  });

  it("aviso cita quantas e quais", () => {
    expect(echoWarning(dropEchoColumns(file).echo)).toMatch(/^4 coluna\(s\).*cw_synced_at, cw_deleted_at/);
  });
});

describe("wideRowError", () => {
  it("traduz 'row is too big' em erro claro e sem retentativa", () => {
    const e = wideRowError(new Error("row is too big: size 8176, maximum size 8160"), 452);
    expect(e?.message).toMatch(/largo demais para o Postgres \(452 colunas\).*row is too big/);
    expect(isNonRetryable(e)).toBe(true);
  });
  it("outros erros passam", () => {
    expect(wideRowError(new Error("deadlock detected"))).toBeNull();
  });
});
