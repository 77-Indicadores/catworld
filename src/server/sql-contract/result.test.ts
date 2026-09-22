import { describe, expect, it } from "vitest";
import { mssqlKind, normalizeRows, pgDateText, pgKind } from "./result";

describe("contrato de resultado", () => {
  it("mssql: date/time/bigint/decimal/binary", () => {
    const rows = [{ d: new Date("2026-01-31T00:00:00Z"), t: new Date("1970-01-01T10:05:09.120Z"), b: 9007199254740993, m: 12.5, x: Buffer.from("ab"), o: 1 }];
    normalizeRows(rows, { d: "date", t: "time", b: "bigint", m: "decimal", x: "binary", o: "other" }, "mssql");
    expect(rows[0]).toEqual({ d: "2026-01-31", t: "10:05:09.120", b: "9007199254740992", m: "12.5", x: "YWI=", o: 1 });
  });

  it("pg: DATE usa componentes locais (sem deslocar o dia)", () => {
    const local = new Date(2026, 0, 31); // meia-noite local, como o driver pg entrega
    const rows = [{ d: local }];
    normalizeRows(rows, { d: "date" }, "pg");
    expect(rows[0]!.d).toBe("2026-01-31");
  });

  it("datetime vira ISO; null preservado", () => {
    const rows = [{ a: new Date("2026-01-31T10:00:00Z"), b: null }];
    normalizeRows(rows, { a: "datetime", b: "date" }, "mssql");
    expect(rows[0]).toEqual({ a: "2026-01-31T10:00:00.000Z", b: null });
  });

  it("mapeamento de tipos", () => {
    expect(pgKind(1082)).toBe("date");
    expect(pgKind(1700)).toBe("decimal");
    expect(mssqlKind("datetime2")).toBe("datetime");
    expect(mssqlKind("varchar")).toBe("other");
  });
});

describe("legacyFormatColumns (colunas que mudam com normalize)", () => {
  it("Postgres: so date e binary (decimal/bigint ja chegam como string)", async () => {
    const { legacyFormatColumns } = await import("./result");
    expect(legacyFormatColumns({ a: "date", b: "decimal", c: "bigint", d: "binary", e: "other", f: "datetime" }, "pg").sort()).toEqual(["a", "d"]);
  });
  it("SQL Server: date, time, decimal e binary", async () => {
    const { legacyFormatColumns } = await import("./result");
    expect(legacyFormatColumns({ a: "date", b: "decimal", c: "bigint", d: "time", e: "other" }, "mssql").sort()).toEqual(["a", "b", "d"]);
  });
});

describe("pgDateText", () => {
  it("nao corta anos com 5+ digitos", () => {
    expect(pgDateText("12345-01-01")).toBe("12345-01-01");
    expect(pgDateText("2026-01-31")).toBe("2026-01-31");
    expect(pgDateText("2026-01-31T00:00:00")).toBe("2026-01-31");
    expect(pgDateText("infinity")).toBe("infinity");
  });
});
