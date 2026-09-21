import { describe, expect, it } from "vitest";
import { resolveAgainstExisting } from "./existing-types";
import { incompatibleColumns } from "./type-compat";
import { isNonRetryable } from "./non-retryable";
import type { ParsedColumn } from "./parser";

const col = (o: Partial<ParsedColumn> & { sqlName: string }): ParsedColumn => ({ originalName: o.sqlName, sqlType: "NVARCHAR(MAX)", nullable: true, ...o });

describe("resolveAgainstExisting: a coluna fisica manda no append/upsert/delta", () => {
  it("datas ambiguas (todos os dias <= 12) herdam DATE e a ordem da carga anterior", () => {
    const m = [col({ sqlName: "d", dateAmbiguous: true })];
    const out = resolveAgainstExisting(m, [{ name: "d", sqlType: "DATE" }], [col({ sqlName: "d", sqlType: "DATE", dateOrder: "dmy" })]);
    expect(out[0]).toMatchObject({ sqlType: "DATE", dateOrder: "dmy" });
    expect(out[0]!.dateAmbiguous).toBeUndefined();
    expect(incompatibleColumns([{ name: "d", sqlType: "DATE" }], out)).toEqual([]);
  });
  it("decimais ambiguos (1.234) herdam DECIMAL, o separador e a precisao fisica", () => {
    const m = [col({ sqlName: "v", decimalAmbiguous: true })];
    const out = resolveAgainstExisting(m, [{ name: "v", sqlType: "DECIMAL(18,3)" }], [col({ sqlName: "v", sqlType: "DECIMAL(18,3)", decimalSep: "," })]);
    expect(out[0]).toMatchObject({ sqlType: "DECIMAL(18,3)", decimalSep: ",", decimalDigits: 18 });
    expect(out[0]!.decimalAmbiguous).toBeUndefined();
  });
  it("coluna que virou texto so por parecer identificador (convencao ja decidida) tambem herda o tipo", () => {
    const out = resolveAgainstExisting([col({ sqlName: "doc_data", dateOrder: "mdy" })], [{ name: "doc_data", sqlType: "DATE" }], null);
    expect(out[0]).toMatchObject({ sqlType: "DATE", dateOrder: "mdy" });
  });
  it("ambigua SEM convencao registrada: falha alto e nao repetivel (nunca chuta)", () => {
    let err: unknown;
    try { resolveAgainstExisting([col({ sqlName: "d", dateAmbiguous: true })], [{ name: "d", sqlType: "DATE" }], null); } catch (e) { err = e; }
    expect((err as Error).message).toMatch(/ambíguas/);
    expect(isNonRetryable(err)).toBe(true);
    expect(() => resolveAgainstExisting([col({ sqlName: "v", decimalAmbiguous: true })], [{ name: "v", sqlType: "DECIMAL(10,2)" }], [])).toThrow(/ambíguos/);
  });
  it("texto genuino contra DATE continua incompativel (nada e forcado)", () => {
    const out = resolveAgainstExisting([col({ sqlName: "d" })], [{ name: "d", sqlType: "DATE" }], null);
    expect(out[0]!.sqlType).toBe("NVARCHAR(MAX)");
    expect(incompatibleColumns([{ name: "d", sqlType: "DATE" }], out)).toHaveLength(1);
  });
  it("coluna existente de texto e coluna ja tipada nao mudam", () => {
    const m = [col({ sqlName: "a", dateAmbiguous: true }), col({ sqlName: "b", sqlType: "DATE", dateOrder: "dmy" })];
    const out = resolveAgainstExisting(m, [{ name: "a", sqlType: "NVARCHAR(MAX)" }, { name: "b", sqlType: "DATE" }], null);
    expect(out).toEqual(m);
  });
});
