import { describe, expect, it } from "vitest";
import { dedupeColumnNames, rowsFromArrays } from "./columns";

describe("dedupeColumnNames", () => {
  it("nomes unicos ficam como estao", () => {
    expect(dedupeColumnNames(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });
  it("repetidos ganham sufixo; a 1a ocorrencia mantem o nome", () => {
    expect(dedupeColumnNames(["Id", "Id", "nome", "Id"])).toEqual(["Id", "Id_2", "nome", "Id_3"]);
  });
  it("nao colide com um nome que ja existe na consulta", () => {
    expect(dedupeColumnNames(["Id", "Id", "Id_2"])).toEqual(["Id", "Id_3", "Id_2"]);
  });
  it("e deterministico e vazio funciona", () => {
    expect(dedupeColumnNames(["x", "x"])).toEqual(dedupeColumnNames(["x", "x"]));
    expect(dedupeColumnNames([])).toEqual([]);
  });
});

describe("rowsFromArrays", () => {
  it("monta objetos com os nomes finais, sem perder a coluna repetida", () => {
    const names = dedupeColumnNames(["Id", "Id"]);
    expect(rowsFromArrays([[1, 10], [2, 20]], names)).toEqual([{ Id: 1, Id_2: 10 }, { Id: 2, Id_2: 20 }]);
  });
});
