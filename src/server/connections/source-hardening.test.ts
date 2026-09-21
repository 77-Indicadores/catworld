import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db", () => ({ prisma: {} }));
vi.mock("@/server/azure/sql", () => ({ sqlPool: vi.fn(), ensureSchema: vi.fn() }));

import { Cron } from "croner";
import { exposeSource } from "./sources";
import { defaultReconciliationCron, jitteredReconciliationCron } from "./source-guards";
import { makeRowConverter } from "./source-row-convert";
import { convertSourceValue } from "./source-values";

describe("M5: reconciliacao padrao espalhada por hash do id", () => {
  it("determinista por id, hora 1-5 UTC, minuto 0-59, e nao todas iguais", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const c = jitteredReconciliationCron(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
      const [m, h, ...rest] = c.split(" ");
      expect(rest).toEqual(["*", "*", "*"]);
      expect(Number(m)).toBeGreaterThanOrEqual(0); expect(Number(m)).toBeLessThan(60);
      expect(Number(h)).toBeGreaterThanOrEqual(1); expect(Number(h)).toBeLessThanOrEqual(5);
      expect(() => new Cron(c, { timezone: "UTC" })).not.toThrow();
      seen.add(c);
    }
    expect(seen.size).toBeGreaterThan(100); // ~300 horarios possiveis: nada de "todo mundo as 03:15"
    expect(jitteredReconciliationCron("abc")).toBe(jitteredReconciliationCron("abc"));
  });
  it("usa o jitter quando ha semente e o padrao antigo sem ela; escolha explicita e respeitada", () => {
    const i = { mode: "extract", keyColumn: "id", sourceKind: "table" };
    expect(defaultReconciliationCron(i)).toBe("15 3 * * *");
    expect(defaultReconciliationCron(i, "semente")).toBe(jitteredReconciliationCron("semente"));
    expect(defaultReconciliationCron({ ...i, reconciliationCron: null }, "semente")).toBeNull();
  });
});

describe("L5: o marcador de trava nao vaza na API", () => {
  it("lastError 'lease:<uuid>' vira null; erro real e preservado", () => {
    expect(exposeSource({ id: "a", lastError: "lease:9b2c", mode: "extract" }).lastError).toBeNull();
    expect(exposeSource({ id: "a", lastError: "timeout", mode: "extract" }).lastError).toBe("timeout");
    expect(exposeSource({ id: "a", mode: "extract" })).not.toHaveProperty("lastError");
  });
});

describe("M4: onInvalid por fonte", () => {
  const cols = [{ originalName: "d", sqlName: "d", sqlType: "DATE" }, { originalName: "n", sqlName: "n", sqlType: "BIGINT" }];
  it("fonte legada (sem opcoes): infinity/BC viram NULL com aviso", () => {
    const c = makeRowConverter(cols, {});
    expect(c.convertRow({ d: "infinity", n: 1 })).toEqual([null, "1"]);
    expect(c.convertRow({ d: "0044-03-15 BC", n: 2 })).toEqual([null, "2"]);
    expect(c.notes().join(" ")).toMatch(/INVALID_VALUES_NULLED.*d: 2/);
  });
  it("fonte nova (strict): a carga falha; onInvalid:'null' explicito volta ao NULL", () => {
    expect(() => makeRowConverter(cols, { strict: true, onInvalid: "fail" }).convertRow({ d: "infinity", n: 1 })).toThrow(/nao representavel/);
    expect(makeRowConverter(cols, { strict: true, onInvalid: "null" }).convertRow({ d: "infinity", n: 1 })[0]).toBeNull();
    expect(() => makeRowConverter(cols, {}).convertRow({ d: "2024-01-01", n: "x" })).toThrow(); // valor invalido que nao e "irrepresentavel" sempre falha
  });
});

describe("L3: decimal de MSSQL (double) com mais de 15 digitos", () => {
  const cols = [{ originalName: "v", sqlName: "v", sqlType: "DECIMAL(18,4)" }];
  it("estrito (fonte nova): continua falhando", () => {
    expect(() => convertSourceValue(1234567890123.4567, "DECIMAL(18,4)")).toThrow(/15 digitos/);
    expect(() => makeRowConverter(cols, { strict: true, onInvalid: "fail" }).convertRow({ v: 1234567890123.4567 })).toThrow(/15 digitos/);
  });
  it("legado: arredonda e avisa em vez de parar a sincronizacao", () => {
    const c = makeRowConverter(cols, {});
    expect(c.convertRow({ v: 1234567890123.4567 })).toEqual(["1234567890123.4568"]);
    expect(c.notes().join(" ")).toMatch(/LEGACY_PRECISION.*v/);
  });
});
