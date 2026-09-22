import { describe, expect, it } from "vitest";
import { compareWithCatalog, convertSourceValue, type ResolvedColumn } from "./source-values";

const col = (sqlName: string, sqlType: string, extra: Partial<ResolvedColumn> = {}): ResolvedColumn => ({ originalName: sqlName, sqlName, sqlType, nullable: true, ...extra });

describe("H1: diferenca so de mapeamento nao e mudanca estrutural", () => {
  it("money (19,4) contra legado (18,4): mantem o legado, nao recarrega", () => {
    const r = compareWithCatalog([col("preco", "DECIMAL(19,4)")], [{ sqlName: "preco", sqlType: "DECIMAL(18,4)" }]);
    expect(r.changed).toBe(false);
    expect(r.columns[0]!.sqlType).toBe("DECIMAL(18,4)");
    expect(r.columns[0]!.legacyRound).toBeFalsy();
  });
  it("numeric(20,6) contra legado (18,4): mantem o legado com arredondamento legado", () => {
    const r = compareWithCatalog([col("q", "DECIMAL(20,6)")], [{ sqlName: "q", sqlType: "DECIMAL(18,4)" }]);
    expect(r.changed).toBe(false);
    expect(r.columns[0]).toMatchObject({ sqlType: "DECIMAL(18,4)", legacyRound: true });
    expect(convertSourceValue("0.123456", "DECIMAL(18,4)", { legacyRound: true })).toBe("0.1235");
  });
  it("timetz: legado TIME continua TIME e o deslocamento e descartado", () => {
    const r = compareWithCatalog([col("h", "NVARCHAR(MAX)", { pgType: "timetz" })], [{ sqlName: "h", sqlType: "TIME" }]);
    expect(r.changed).toBe(false);
    expect(r.columns[0]!.sqlType).toBe("TIME");
    expect(convertSourceValue("12:30:00+03", "TIME")).toBe("12:30:00");
    expect(convertSourceValue("12:30:00.5-03:30", "TIME")).toBe("12:30:00.5");
    expect(convertSourceValue("12:30:00", "TIME")).toBe("12:30:00");
  });
  it("mudanca estrutural de verdade continua detectada", () => {
    expect(compareWithCatalog([col("a", "DATE")], [{ sqlName: "a", sqlType: "DECIMAL(18,4)" }]).changed).toBe(true);
    expect(compareWithCatalog([col("a", "BIGINT"), col("b", "BIGINT")], [{ sqlName: "a", sqlType: "BIGINT" }]).changed).toBe(true);
    expect(compareWithCatalog([col("a", "BIGINT")], [{ sqlName: "a", sqlType: "BIGINT" }, { sqlName: "z", sqlType: "BIGINT" }]).changed).toBe(true);
  });
});


describe("TIME vindo do driver MSSQL como Date", () => {
  it("vira HH:MM:SS.mmm em UTC", () => {
    expect(convertSourceValue(new Date("1970-01-01T12:30:15.250Z"), "TIME")).toBe("12:30:15.250");
  });
});
