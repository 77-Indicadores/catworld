import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, keyLiteral, settleFirstPage, shapeRowsPage, TIE_CAP, type PageRow } from "./since";

const T0 = new Date("2026-01-01T00:00:00Z");
// linha "n" do lote `ts` (texto igual ao do banco)
const row = (n: number, ts: string): PageRow => ({ id: n, __cw_synced_at: new Date(`${ts.replace(" ", "T")}Z`), __cw_synced_txt: ts, __cw_key: String(n) });
const batch = (from: number, count: number, ts: string) => Array.from({ length: count }, (_, i) => row(from + i, ts));

describe("cursor", () => {
  it("ida e volta; rejeita lixo", () => {
    const c = encodeCursor({ t: "2026-09-19 10:00:00.123456", k: 42 });
    expect(decodeCursor(c)).toEqual({ t: "2026-09-19 10:00:00.123456", k: 42 });
    expect(decodeCursor("lixo")).toBeNull();
    expect(decodeCursor(Buffer.from(JSON.stringify({ t: "amanha", k: 1 })).toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from(JSON.stringify({ t: "2026-09-19 10:00:00", k: { x: 1 } })).toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from(JSON.stringify({ t: "2026-09-19 10:00:00'; DROP TABLE x;--", k: 1 })).toString("base64url"))).toBeNull();
  });
  it("keyLiteral valida numero e escapa texto (nada cru para o SQL)", () => {
    expect(keyLiteral("123", "BIGINT")).toBe("123");
    expect(() => keyLiteral("1; DROP TABLE x", "BIGINT")).toThrow();
    expect(keyLiteral("o'brien", "NVARCHAR(MAX)")).toBe("'o''brien'");
  });
});

describe("settleFirstPage (sem cursor: nunca corta grupo empatado, nextSince sempre avanca)", () => {
  it("cabe no limit: pagina completa, sem hasMore", async () => {
    const s = await settleFirstPage(batch(1, 3, "2026-09-19 10:00:00"), 5, T0, async () => []);
    expect(s.page).toHaveLength(3);
    expect(s.hasMore).toBe(false);
    expect(s.nextSince.toISOString()).toBe("2026-09-19T10:00:00.000Z");
  });

  it("corte cai ENTRE grupos: nao busca mais nada", async () => {
    const first = [...batch(1, 3, "2026-09-19 10:00:00"), ...batch(4, 1, "2026-09-19 11:00:00")]; // limit 3 -> +1
    let fetched = false;
    const s = await settleFirstPage(first, 3, T0, async () => { fetched = true; return []; });
    expect(fetched).toBe(false);
    expect(s.page.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(s.hasMore).toBe(true);
    expect(s.nextSince.toISOString()).toBe("2026-09-19T10:00:00.000Z"); // proxima chamada (>) comeca no grupo das 11h
  });

  it("corte cai NO MEIO do grupo (o bug): traz o grupo inteiro e avanca", async () => {
    const group = batch(1, 2500, "2026-09-19 10:00:00");
    const later = batch(9001, 10, "2026-09-19 12:00:00");
    const first = [...group.slice(0, 1001)]; // limit 1000 (+1)
    const s = await settleFirstPage(first, 1000, T0, async () => [...group, ...later]);
    expect(s.page).toHaveLength(2500);                 // passou do limit para nao partir o grupo
    expect(s.hasMore).toBe(true);                       // ainda ha as das 12h
    expect(s.nextSince.toISOString()).toBe("2026-09-19T10:00:00.000Z");
    expect(s.tieGroupTruncated).toBeUndefined();
  });

  it("grupo empatado e o fim da tabela: pagina completa, sem hasMore", async () => {
    const group = batch(1, 1500, "2026-09-19 10:00:00");
    const s = await settleFirstPage(group.slice(0, 1001), 1000, T0, async () => group);
    expect(s.page).toHaveLength(1500);
    expect(s.hasMore).toBe(false);
  });

  it("grupo MAIOR que TIE_CAP: nao trava (avanca como antes), sinaliza e oferece cursor", async () => {
    const huge = batch(1, TIE_CAP + 1, "2026-09-19 10:00:00");
    const s = await settleFirstPage(huge.slice(0, 1001), 1000, T0, async () => huge);
    expect(s.page).toHaveLength(1000);
    expect(s.hasMore).toBe(true);
    expect(s.tieGroupTruncated).toBe(true);
    expect(s.nextCursor).not.toBeNull();
    expect(s.nextSince.toISOString()).toBe("2026-09-19T10:00:00.000Z");
  });

  it("limit 0 nao quebra", async () => {
    const s = await settleFirstPage(batch(1, 1, "2026-09-19 10:00:00"), 0, T0, async () => []);
    expect(s.page).toHaveLength(0);
    expect(s.hasMore).toBe(true);
  });
});

describe("shapeRowsPage (paginas COM cursor: estritas; nextSince conservador)", () => {
  it("pagina cheia: hasMore, cursor da ultima linha, nextSince = grupo anterior (ou since)", () => {
    const rows = [...batch(1, 2, "2026-09-19 09:00:00"), ...batch(3, 3, "2026-09-19 10:00:00")]; // limit 3 -> pega 1,2,3 ; 4 sobra
    const s = shapeRowsPage(rows, 3, T0);
    expect(s.page.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(s.hasMore).toBe(true);
    expect(decodeCursor(s.nextCursor!)).toEqual({ t: "2026-09-19 10:00:00", k: "3" });
    expect(s.nextSince.toISOString()).toBe("2026-09-19T09:00:00.000Z");
  });
  it("pagina inteira de um grupo so: nextSince = since (nunca pula)", () => {
    const s = shapeRowsPage(batch(1, 4, "2026-09-19 10:00:00"), 3, T0);
    expect(s.hasMore).toBe(true);
    expect(s.nextSince).toEqual(T0);
  });
  it("ultima pagina: nextSince = maior timestamp", () => {
    const s = shapeRowsPage(batch(1, 2, "2026-09-19 10:00:00"), 3, T0);
    expect(s.hasMore).toBe(false);
    expect(s.nextSince.toISOString()).toBe("2026-09-19T10:00:00.000Z");
  });
});
