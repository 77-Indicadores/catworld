import { describe, expect, it } from "vitest";
import { csvField, xlsxCell } from "./export-format";

describe("export-format", () => {
  it("csv: bigint, objeto, Date, null e aspas", () => {
    expect(csvField(10n)).toBe('"10"');
    expect(csvField({ a: 1n })).toBe('"{""a"":""1""}"');
    expect(csvField(new Date("2024-01-02T03:04:05Z"), true)).toBe('"2024-01-02T03:04:05.000Z"');
    expect(csvField(null)).toBe('""');
    expect(csvField('a"b')).toBe('"a""b"');
  });
  it("xlsx: bigint e objeto viram texto; numero/data ficam nativos", () => {
    expect(xlsxCell(5n)).toBe("5");
    expect(xlsxCell({ x: 1 })).toBe('{"x":1}');
    expect(xlsxCell(3)).toBe(3);
    const d = new Date(0);
    expect(xlsxCell(d)).toBe(d);
    expect(xlsxCell(undefined)).toBeNull();
  });
});
