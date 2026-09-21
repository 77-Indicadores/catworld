/**
 * ENT-05: since sem depender do fuso do Node, com microssegundos e janela de seguranca.
 * Rode tambem com TZ=Asia/Tokyo e TZ=America/Sao_Paulo (o resultado tem de ser identico).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SAFETY_WINDOW_MS, finalizeNextSince, fromMicros, normTs, parseSince, pgRowsPageSql, rowStampsOf, safetyWindowMs, settleFirstPage, shapeRowsPage, toMicros, type PageRow } from "./since";

const row = (n: number, ts: string): PageRow => ({ id: n, __cw_synced_txt: ts, __cw_key: String(n) });

describe("parseSince: UTC sem depender do fuso do processo, com microssegundos", () => {
  it("sem fuso e com Z sao o mesmo instante; mantem 6 casas", () => {
    expect(parseSince("2026-09-19T10:00:00.123456")?.txt).toBe("2026-09-19 10:00:00.123456");
    expect(parseSince("2026-09-19T10:00:00.123456Z")?.txt).toBe("2026-09-19 10:00:00.123456");
    expect(parseSince("2026-09-19 10:00:00")?.txt).toBe("2026-09-19 10:00:00.000000");
    expect(parseSince("2026-09-19")?.txt).toBe("2026-09-19 00:00:00.000000");
    expect(parseSince("2026-09-19T10:00:00.1Z")?.iso).toBe("2026-09-19T10:00:00.100000Z");
  });
  it("offset e convertido para UTC", () => {
    expect(parseSince("2026-09-19T10:00:00.5+03:00")?.txt).toBe("2026-09-19 07:00:00.500000");
    expect(parseSince("2026-09-19T00:30:00-0300")?.txt).toBe("2026-09-19 03:30:00.000000");
  });
  it("invalidos", () => {
    for (const s of ["", "ontem", "2026-13-01", "2026-02-31", "2026-09-19T25:00:00", "2026-09-19'; DROP TABLE x;--"]) expect(parseSince(s), s).toBeNull();
  });
  it("horario de verao (lacuna 2026-03-08 02:30 em America/New_York) nao altera nada: e sempre UTC", () => {
    expect(parseSince("2026-03-08T02:30:00")?.txt).toBe("2026-03-08 02:30:00.000000");
    expect(parseSince("2026-11-01T01:30:00")?.txt).toBe("2026-11-01 01:30:00.000000");
  });
  it("literal SQL so contem digitos", () => {
    expect(parseSince("2026-09-19T10:00:00.123456Z")?.sqlLiteral).toBe("'2026-09-19 10:00:00.123456'");
  });
});

describe("aritmetica de microssegundos", () => {
  it("ida e volta, inclusive ano < 100 e antes de 1970", () => {
    for (const t of ["2026-09-19 10:00:00.123456", "1969-12-31 23:59:59.999999", "0001-01-01 00:00:00.000000", "2026-03-08 02:30:00.000001"]) {
      expect(fromMicros(toMicros(t))).toBe(t);
    }
  });
  it("normTs", () => {
    expect(normTs("2026-09-19 10:00:00.1234567")).toBe("2026-09-19 10:00:00.123456");
    expect(normTs("nao")).toBeNull();
  });
});

describe("nextSince a partir do TEXTO (a linha nao volta para sempre)", () => {
  it("microssegundos preservados: o proximo since e exatamente o carimbo da linha", async () => {
    const s = await settleFirstPage([row(1, "2026-09-19 10:00:00.123456")], 10, "2026-09-19T09:00:00Z", async () => []);
    expect(s.nextSinceTxt).toBe("2026-09-19 10:00:00.123456");
    // o Date antigo truncaria para .123 e o `>` traria a linha de novo
    expect(parseSince(isoOf(s.nextSinceTxt))?.sqlLiteral).toBe("'2026-09-19 10:00:00.123456'");
  });
  it("SQL da pagina compara com timestamp de 6 casas e devolve o carimbo como texto", () => {
    const sql = pgRowsPageSql({ qTarget: '"s"."t"', colList: '"id"', qSynced: '"cw_synced_at"', qDeleted: '"cw_deleted_at"', qKey: '"id"', keySqlType: "BIGINT", sinceLit: parseSince("2026-09-19T10:00:00.123456Z")!.sqlLiteral, cursor: null, limit: 10 });
    expect(sql).toContain(`"cw_synced_at" > '2026-09-19 10:00:00.123456'::timestamp`);
    expect(sql).toContain(`"cw_synced_at"::text AS __cw_synced_txt`);
  });
  it("paginas com cursor: nextSince conservador em texto", () => {
    const s = shapeRowsPage([row(1, "2026-09-19 09:00:00.000001"), row(2, "2026-09-19 10:00:00.5"), row(3, "2026-09-19 10:00:00.5")], 2, "2026-09-01T00:00:00Z");
    expect(s.hasMore).toBe(true);
    expect(s.nextSinceTxt).toBe("2026-09-19 09:00:00.000001");
  });
});
const isoOf = (t: string) => `${t.replace(" ", "T")}Z`;

describe("finalizeNextSince: janela de seguranca (ordem de commit)", () => {
  const W = 300_000;
  const now = "2026-09-19 10:10:00.000000";
  const base = { nowTxt: now, windowMs: W, since: "2026-09-19T09:00:00.000000Z" } as const;

  it("carimbo antigo (fora da janela): nextSince = o carimbo (estabiliza, sem repeticao)", () => {
    const n = finalizeNextSince({ ...base, settled: { hasMore: false, nextSinceTxt: "2026-09-19 09:30:00.250000" } });
    expect(n).toBe("2026-09-19T09:30:00.250000Z");
  });
  it("carimbo recente (dentro da janela): recua ate agora-janela, para uma transacao lenta ainda aparecer", () => {
    const n = finalizeNextSince({ ...base, settled: { hasMore: false, nextSinceTxt: "2026-09-19 10:09:00.000000" } });
    expect(n).toBe("2026-09-19T10:05:00.000000Z");
  });
  it("nunca regride abaixo do since recebido", () => {
    const n = finalizeNextSince({ ...base, since: "2026-09-19T10:08:00Z", settled: { hasMore: false, nextSinceTxt: "2026-09-19 10:09:00.000000" } });
    expect(n).toBe("2026-09-19T10:08:00.000000Z");
  });
  it("nada mudou: devolve o proprio since", () => {
    const n = finalizeNextSince({ ...base, settled: { hasMore: false, nextSinceTxt: "2026-09-19 09:00:00.000000" } });
    expect(n).toBe("2026-09-19T09:00:00.000000Z");
  });
  it("com mais paginas: valor conservador da pagina, sem janela", () => {
    const n = finalizeNextSince({ ...base, settled: { hasMore: true, nextSinceTxt: "2026-09-19 09:59:59.000001" } });
    expect(n).toBe("2026-09-19T09:59:59.000001Z");
  });
  it("exclusoes recentes tambem respeitam a janela", () => {
    const n = finalizeNextSince({ ...base, settled: { hasMore: false, nextSinceTxt: "2026-09-19 09:00:00.000000" }, removedMaxTxt: "2026-09-19 10:09:30.7" });
    expect(n).toBe("2026-09-19T10:05:00.000000Z");
  });
  it("simulacao do problema de ordem de commit: linha com carimbo antigo commitada depois NAO se perde", () => {
    // T1 carimba 10:00:00 (transacao longa, ainda nao commitou); T2 carimba 10:00:30 e commita; cliente le.
    const nowTxt = "2026-09-19 10:01:00.000000";
    const r1 = finalizeNextSince({ nowTxt, windowMs: W, since: "2026-09-19T09:00:00Z", settled: { hasMore: false, nextSinceTxt: "2026-09-19 10:00:30.000000" } });
    // T1 commita agora; seu carimbo (10:00:00) e MAIOR que r1?  r1 = min(10:00:30, 10:01:00-5min=09:56:00) = 09:56:00 -> ainda visivel
    expect(normTs(r1.replace("T", " ").replace("Z", ""))! < "2026-09-19 10:00:00.000000").toBe(true);
  });
  it("janela configuravel por env; invalida cai no padrao", () => {
    expect(safetyWindowMs({})).toBe(DEFAULT_SAFETY_WINDOW_MS);
    expect(safetyWindowMs({ CW_SINCE_SAFETY_WINDOW_SEC: "60" })).toBe(60_000);
    expect(safetyWindowMs({ CW_SINCE_SAFETY_WINDOW_SEC: "0" })).toBe(0);
    expect(safetyWindowMs({ CW_SINCE_SAFETY_WINDOW_SEC: "abc" })).toBe(DEFAULT_SAFETY_WINDOW_MS);
  });
  it("rowStamps na ordem da pagina", () => {
    expect(rowStampsOf([row(1, "2026-09-19 10:00:00.5"), row(2, "2026-09-19 10:00:01")])).toEqual(["2026-09-19T10:00:00.500000Z", "2026-09-19T10:00:01.000000Z"]);
  });
});

// O fuso do processo NAO pode mudar nada (process.env.TZ em runtime vale em Node, inclusive no Windows)
describe.each(["UTC", "Asia/Tokyo", "America/Sao_Paulo", "America/New_York"])("independente do fuso do processo: TZ=%s", (tz) => {
  const original = process.env.TZ;
  beforeAll(() => { process.env.TZ = tz; });
  afterAll(() => { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; });

  it("o fuso foi realmente aplicado (sanidade do teste)", () => {
    const off = new Date(2026, 0, 15).getTimezoneOffset();
    expect(off).toBe({ UTC: 0, "Asia/Tokyo": -540, "America/Sao_Paulo": 180, "America/New_York": 300 }[tz]);
  });
  it("parse/format e janela sao identicos, inclusive na lacuna do horario de verao", () => {
    expect(parseSince("2026-03-08T02:30:00")?.iso).toBe("2026-03-08T02:30:00.000000Z");
    expect(parseSince("2026-11-01T01:30:00.000123")?.iso).toBe("2026-11-01T01:30:00.000123Z");
    expect(parseSince("2026-09-19T10:00:00.123456-03:00")?.iso).toBe("2026-09-19T13:00:00.123456Z");
    const n = finalizeNextSince({ settled: { hasMore: false, nextSinceTxt: "2026-03-08 02:30:00.000001" }, since: "2026-03-01T00:00:00Z", nowTxt: "2026-03-08 09:00:00", windowMs: 60_000 });
    expect(n).toBe("2026-03-08T02:30:00.000001Z");
  });
  it("carimbo devolvido pelo pg como Date (legado) e convertido por ms UTC, nao por hora local", async () => {
    const s = await settleFirstPage([{ id: 1, __cw_synced_txt: undefined, __cw_synced_at: new Date("2026-09-19T10:00:00.250Z") } as PageRow], 5, "2026-09-19T00:00:00Z", async () => []);
    expect(s.nextSinceTxt).toBe("2026-09-19 10:00:00.250000");
  });
});

describe("parseSince: ano invalido devolve null (400), nunca 500", () => {
  it("ano 0000 e underflow por offset", () => {
    expect(parseSince("0000-01-01T00:00:00Z")).toBeNull();
    expect(parseSince("0001-01-01T00:00:00+03:00")).toBeNull();
    expect(parseSince("0001-01-01T00:00:00Z")?.txt).toBe("0001-01-01 00:00:00.000000");
  });
});
