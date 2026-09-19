import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { WorkspaceDataset } from "@/lib/workspace/types";
import { ResultGrid, isNumericColumn } from "./result-grid";
import { SchemaBrowser, columnToken } from "./schema-browser";
import { QueryPanel } from "./query-panel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const col = (id: string, sqlName: string, sqlType: string) => ({ id, sqlName, originalName: sqlName, sqlType, nullable: false });
const datasets = [{
  id: "d1", name: "DS", schemaName: "ds_test",
  tables: [
    { id: "t1", name: "vendas", sqlName: "vendas", columns: [col("c1", "id", "BIGINT"), col("c2", "Nome", "NVARCHAR(MAX)")] },
    { id: "t2", name: "clientes", sqlName: "clientes", columns: [col("c3", "cidade", "NVARCHAR(200)")] },
  ],
}] as unknown as WorkspaceDataset[];

describe("ResultGrid", () => {
  it("NULL destacado (não é o texto 'NULL') e números alinhados à direita", () => {
    render(<ResultGrid columns={["id", "nome"]} rows={[{ id: "10", nome: null }, { id: "2", nome: "Ana" }]} />);
    const nullCell = screen.getByText("NULL");
    expect(nullCell.className).toMatch(/italic/);
    expect(screen.getByText("10").className).toMatch(/text-right/);
    expect(screen.getByText("Ana").className).not.toMatch(/text-right/);
  });
  it("coluna só é numérica se TODO valor é numérico; vazia não é", () => {
    expect(isNumericColumn([{ a: "1" }, { a: 2.5 }, { a: null }], "a")).toBe(true);
    expect(isNumericColumn([{ a: "1" }, { a: "x" }], "a")).toBe(false);
    expect(isNumericColumn([{ a: null }], "a")).toBe(false);
  });
  it("hora de TIME do mssql sai só como HH:MM:SS (fmtCell)", () => {
    render(<ResultGrid columns={["h"]} rows={[{ h: "1970-01-01T08:30:15.000Z" }]} />);
    expect(screen.getByText("08:30:15")).toBeInTheDocument();
  });
});

describe("SchemaBrowser", () => {
  it("insere schema.tabela ao clicar na tabela e a coluna (com colchetes se preciso)", () => {
    const onInsert = vi.fn();
    render(<SchemaBrowser datasets={datasets} onInsert={onInsert} />);
    fireEvent.click(screen.getByTitle("Inserir ds_test.vendas"));
    expect(onInsert).toHaveBeenLastCalledWith("ds_test.vendas");
    fireEvent.click(screen.getByRole("button", { name: "Expandir colunas de vendas" }));
    fireEvent.click(screen.getByTitle("Inserir [Nome]"));
    expect(onInsert).toHaveBeenLastCalledWith("[Nome]");
    fireEvent.click(screen.getByTitle("Inserir id"));
    expect(onInsert).toHaveBeenLastCalledWith("id");
    expect(columnToken("data_venda")).toBe("data_venda");
    expect(columnToken("Valor Total")).toBe("[Valor Total]");
  });
  it("filtra por tabela ou coluna e avisa quando nada casa", () => {
    render(<SchemaBrowser datasets={datasets} onInsert={() => undefined} />);
    fireEvent.change(screen.getByPlaceholderText("Buscar tabela ou coluna…"), { target: { value: "cidade" } });
    expect(screen.getByText("clientes")).toBeInTheDocument();
    expect(screen.queryByText("vendas")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Buscar tabela ou coluna…"), { target: { value: "zzz" } });
    expect(screen.getByText("Nada encontrado.")).toBeInTheDocument();
  });
});

describe("QueryPanel com navegador de tabelas", () => {
  it("clicar numa tabela insere no editor, com espaço quando necessário", () => {
    // O editor SQL virou CodeMirror (não dá pra simular digitação via fireEvent.change num
    // contentEditable em jsdom) — verifica o texto inicial + inserção pelo conteúdo renderizado.
    const { container } = render(<QueryPanel datasets={datasets} />);
    fireEvent.click(screen.getByTitle("Inserir ds_test.clientes"));
    const text = container.querySelector(".cm-content")?.textContent ?? "";
    // Valor inicial do editor já termina com espaço ("...\nFROM "), então não deve dobrar o espaço.
    expect(text).toContain("FROM ds_test.clientes");
  });
  it("o navegador pode ser recolhido", () => {
    render(<QueryPanel datasets={datasets} />);
    expect(screen.getByRole("navigation", { name: "Tabelas e colunas" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Tabelas/ }));
    expect(screen.queryByRole("navigation", { name: "Tabelas e colunas" })).toBeNull();
  });
});
