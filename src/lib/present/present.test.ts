import { describe, expect, it } from "vitest";
import {
  STALE_MIN_TOLERANCE_MS, normalizeRunStatus, presentCount, presentDateTime, presentRefreshFreshness, presentTableFreshness,
  presentUtc, relativeTime, staleToleranceMs, toBigInt, worstFreshness, type RefreshInput,
} from "./index";

const NOW = new Date("2026-09-19T17:32:05.000Z");

describe("presentDateTime", () => {
  it("mostra data E hora no fuso pedido, com UTC no tooltip (o caso da data sem hora)", () => {
    const p = presentDateTime("2026-09-19T17:32:05.000Z", { now: NOW, timeZone: "America/Sao_Paulo" })!;
    expect(p.absolute).toBe("19/09/2026 14:32");
    expect(p.date).toBe("19/09/2026");
    expect(p.time).toBe("14:32");
    expect(p.tooltip).toBe("19/09/2026 17:32:05 UTC · America/Sao_Paulo (14:32)");
    expect(p.relative).toBe("agora");
  });
  it("segundos opcionais e virada de dia por causa do fuso", () => {
    expect(presentDateTime("2026-09-19T02:05:09Z", { timeZone: "America/Sao_Paulo", seconds: true })!.absolute).toBe("18/09/2026 23:05:09");
    expect(presentDateTime("2026-09-19T02:05:09Z", { timeZone: "UTC" })!.absolute).toBe("19/09/2026 02:05");
  });
  it("meia-noite é 00:00 (nunca 24:00)", () => {
    expect(presentDateTime("2026-09-19T00:00:00Z", { timeZone: "UTC" })!.time).toBe("00:00");
  });
  it("nulo, vazio ou inválido = null (a tela mostra um travessão)", () => {
    for (const bad of [null, undefined, "", "lixo"]) expect(presentDateTime(bad as never)).toBeNull();
  });
  it("aceita Date e epoch", () => {
    expect(presentDateTime(NOW, { timeZone: "UTC" })!.iso).toBe("2026-09-19T17:32:05.000Z");
    expect(presentDateTime(NOW.getTime(), { timeZone: "UTC" })!.absolute).toBe("19/09/2026 17:32");
  });
});

describe("relativeTime", () => {
  it("passado e futuro", () => {
    const at = (min: number) => new Date(NOW.getTime() - min * 60000);
    expect(relativeTime(at(0), NOW)).toBe("agora");
    expect(relativeTime(at(12), NOW)).toBe("há 12 min");
    expect(relativeTime(at(150), NOW)).toBe("há 2h");
    expect(relativeTime(at(60 * 24 * 3), NOW)).toBe("há 3d");
    expect(relativeTime(at(-5), NOW)).toBe("em 5 min");
  });
  it("presentUtc rotula UTC explicitamente (cron)", () => {
    expect(presentUtc("2026-09-19T03:00:00Z")).toBe("19/09/2026 03:00 UTC");
    expect(presentUtc("x")).toBeNull();
  });
});

describe("presentCount (1.5M vs 1.487.197)", () => {
  it("o exato nunca se perde; o compacto é só apoio", () => {
    const c = presentCount("1487197")!;
    expect(c.exact).toBe("1.487.197");
    expect(c.compact).toBe("1,5 mi");
    expect(c.title).toBe("1.487.197 linhas");
  });
  it("BigInt acima de 2^53 continua exato", () => {
    expect(presentCount("9007199254740993")!.exact).toBe("9.007.199.254.740.993");
    expect(presentCount(9007199254740993n)!.value).toBe(9007199254740993n);
  });
  it("faixas do compacto", () => {
    expect(presentCount(999)!.compact).toBe("999");
    expect(presentCount(12_345)!.compact).toBe("12,3 mil");
    expect(presentCount(1_000_000)!.compact).toBe("1 mi");
    expect(presentCount(2_500_000_000)!.compact).toBe("2,5 bi");
  });
  it("singular, zero, negativo, nulo e lixo", () => {
    expect(presentCount(1)!.title).toBe("1 linha");
    expect(presentCount(0)!.exact).toBe("0");
    expect(presentCount(-1500)!.exact).toBe("-1.500");
    expect(presentCount(null)).toBeNull();
    expect(presentCount("abc")).toBeNull();
    expect(toBigInt(NaN)).toBeNull();
  });
});

describe("normalizeRunStatus", () => {
  it("unifica o vocabulário de fonte e derivada", () => {
    for (const s of ["completed", "ok", "ready", "OK"]) expect(normalizeRunStatus(s)).toBe("ok");
    expect(normalizeRunStatus("queued")).toBe("queued");
    expect(normalizeRunStatus("running")).toBe("running");
    expect(normalizeRunStatus("failed")).toBe("failed");
    expect(normalizeRunStatus(null)).toBe("unknown");
    expect(normalizeRunStatus("coisa")).toBe("unknown");
  });
});

const src = (over: Partial<RefreshInput> = {}): RefreshInput => ({
  mode: "extract", active: true, lastStatus: "completed", lastError: null,
  refreshCron: "0 * * * *", nextRefreshAt: "2026-09-19T18:00:00Z", lastRefreshedAt: "2026-09-19T17:00:00Z", ...over,
});

describe("integridade e fila parada (estudo de confiabilidade)", () => {
  it("última carga barrada/suspeita vence 'Em dia' e o erro: 'Possivelmente incompleta'", () => {
    const f = presentTableFreshness({ lastDataAt: "2026-09-19T17:00:00Z", sources: [src()], integrity: { verdict: "FAILED", reason: "Foram lidas 50000 linhas, mas a origem tem 828672." } }, NOW);
    expect(f).toMatchObject({ kind: "suspect", label: "Possivelmente incompleta", tone: "error", severity: 7 });
    expect(f.reason).toContain("828672");
    expect(f.severity).toBeGreaterThan(presentRefreshFreshness(src({ lastStatus: "failed" }), NOW).severity);
  });
  it("veredito OK ou ausente não muda nada", () => {
    expect(presentTableFreshness({ lastDataAt: null, sources: [src()], integrity: { verdict: "OK", reason: null } }, NOW).kind).toBe("ok");
    expect(presentTableFreshness({ lastDataAt: null, sources: [src()] }, NOW).kind).toBe("ok");
  });
  it("tabela só de upload também é marcada (sem agenda, mas dado suspeito)", () => {
    expect(presentTableFreshness({ lastDataAt: "2026-09-19T17:00:00Z", sources: [], integrity: { verdict: "SUSPECT", reason: null } }, NOW).kind).toBe("suspect");
  });
  it("fonte 'na fila'/'atualizando' há mais de 30 min depois do previsto é ATRASADA (parada), não 'em andamento'", () => {
    const stuck = "2026-09-19T14:00:00Z"; // NOW é 2026-09-19T18:00Z: previsto há 4 h
    expect(presentRefreshFreshness(src({ lastStatus: "queued", nextRefreshAt: stuck }), NOW)).toMatchObject({ kind: "stale", label: "Atrasada" });
    expect(presentRefreshFreshness(src({ lastStatus: "running", nextRefreshAt: stuck }), NOW).kind).toBe("stale");
    // dentro da tolerância continua "em andamento"
    expect(presentRefreshFreshness(src({ lastStatus: "queued", nextRefreshAt: "2026-09-19T17:50:00Z" }), NOW).kind).toBe("running");
  });
});

describe("M2: rodada longa saudavel nao e 'possivel travamento'", () => {
  const NOW2 = new Date("2026-09-19T18:00:00Z");
  it("running com batimento recente (renovado a cada minuto) nunca e atrasada, mesmo 90 min depois do previsto", () => {
    const f = presentRefreshFreshness(src({ lastStatus: "running", nextRefreshAt: "2026-09-19T16:30:00Z", updatedAt: "2026-09-19T17:59:00Z" }), NOW2);
    expect(f).toMatchObject({ kind: "running", label: "Atualizando" });
  });
  it("running sem batimento ha mais de 20 min = dono morto: atrasada", () => {
    expect(presentRefreshFreshness(src({ lastStatus: "running", nextRefreshAt: "2026-09-19T17:50:00Z", updatedAt: "2026-09-19T17:30:00Z" }), NOW2).kind).toBe("stale");
  });
  it("running sem dado de batimento: so apos 2 h do previsto; fila continua em 30 min", () => {
    expect(presentRefreshFreshness(src({ lastStatus: "running", nextRefreshAt: "2026-09-19T16:30:00Z" }), NOW2).kind).toBe("running"); // 90 min
    expect(presentRefreshFreshness(src({ lastStatus: "running", nextRefreshAt: "2026-09-19T15:30:00Z" }), NOW2).kind).toBe("stale");   // 150 min
    expect(presentRefreshFreshness(src({ lastStatus: "queued", nextRefreshAt: "2026-09-19T17:00:00Z" }), NOW2).kind).toBe("stale");     // 60 min
    expect(presentRefreshFreshness(src({ lastStatus: "queued", nextRefreshAt: "2026-09-19T17:00:00Z", updatedAt: "2026-09-19T17:59:00Z" }), NOW2).kind).toBe("stale"); // fila ignora batimento
  });
});

describe("M1b: pausada vem antes de suspeita", () => {
  it("todas as origens inativas: Pausada, mesmo com veredito FAILED/SUSPECT", () => {
    expect(presentTableFreshness({ lastDataAt: null, sources: [src({ active: false })], integrity: { verdict: "FAILED", reason: "x" } }, NOW).kind).toBe("paused");
  });
  it("origem ativa com veredito ruim continua suspeita; mista tambem", () => {
    expect(presentTableFreshness({ lastDataAt: null, sources: [src()], integrity: { verdict: "SUSPECT", reason: null } }, NOW).kind).toBe("suspect");
    expect(presentTableFreshness({ lastDataAt: null, sources: [src({ active: false }), src()], integrity: { verdict: "SUSPECT", reason: null } }, NOW).kind).toBe("suspect");
  });
});

describe("presentRefreshFreshness", () => {
  it("em dia", () => expect(presentRefreshFreshness(src(), NOW)).toMatchObject({ kind: "ok", label: "Em dia", tone: "healthy" }));
  it("erro vence tudo e traz a mensagem", () => {
    expect(presentRefreshFreshness(src({ lastStatus: "failed", lastError: "timeout" }), NOW)).toMatchObject({ kind: "failing", tone: "error", reason: "timeout" });
  });
  it("na fila e atualizando", () => {
    expect(presentRefreshFreshness(src({ lastStatus: "queued" }), NOW).label).toBe("Na fila");
    expect(presentRefreshFreshness(src({ lastStatus: "running" }), NOW).label).toBe("Atualizando");
  });
  it("pausada (inativa) não é julgada", () => {
    expect(presentRefreshFreshness(src({ active: false, lastStatus: "failed" }), NOW).kind).toBe("paused");
  });
  it("ao vivo não tem agenda", () => {
    expect(presentRefreshFreshness(src({ mode: "live", refreshCron: null, nextRefreshAt: null, lastStatus: "ready" }), NOW).kind).toBe("live");
  });
  it("sem cron = manual, sem julgar atraso", () => {
    expect(presentRefreshFreshness(src({ refreshCron: null, nextRefreshAt: null }), NOW).kind).toBe("manual");
    expect(presentRefreshFreshness(src({ refreshCron: null, nextRefreshAt: null, lastStatus: null, lastRefreshedAt: null }), NOW).kind).toBe("empty");
  });
  it("atrasada só depois da tolerância (max(2 min, 10% do intervalo))", () => {
    // intervalo de 1h -> tolerância de 6 min; próxima prevista para 18:00
    const within = new Date("2026-09-19T18:05:00Z");
    const beyond = new Date("2026-09-19T18:07:00Z");
    expect(presentRefreshFreshness(src(), within).kind).toBe("ok");
    const late = presentRefreshFreshness(src(), beyond);
    expect(late).toMatchObject({ kind: "stale", label: "Atrasada", tone: "warning" });
    expect(late.reason).toMatch(/Deveria ter atualizado em/);
  });
  it("tolerância mínima de 2 minutos em agendas curtas", () => {
    expect(staleToleranceMs(60_000)).toBe(STALE_MIN_TOLERANCE_MS);
    expect(staleToleranceMs(60 * 60_000)).toBe(6 * 60_000);
  });
});

describe("tabela: agregação e upload sem agenda", () => {
  it("só upload (sem fonte): neutro 'Atualizada há X', nunca atrasada", () => {
    const f = presentTableFreshness({ lastDataAt: "2026-01-01T00:00:00Z", sources: [] }, NOW);
    expect(f.kind).toBe("neutral");
    expect(f.tone).toBe("inactive");
    expect(f.label).toMatch(/^Atualizada há \d+d$/);
    expect(presentTableFreshness({ lastDataAt: null, sources: [] }, NOW).kind).toBe("empty");
  });
  it("com fontes: pior estado entre elas", () => {
    const f = presentTableFreshness({ lastDataAt: null, sources: [src(), src({ lastStatus: "failed", lastError: "x" }), src({ lastStatus: "running" })] }, NOW);
    expect(f.kind).toBe("failing");
  });
  it("derivada entra na agregação", () => {
    expect(presentTableFreshness({ lastDataAt: null, sources: [], derived: src({ lastStatus: "ok" }) }, NOW).kind).toBe("ok");
  });
  it("worstFreshness: ordem falhando > atrasada > atualizando > em dia", () => {
    const a = presentRefreshFreshness(src(), NOW);
    const b = presentRefreshFreshness(src({ lastStatus: "running" }), NOW);
    const c = presentRefreshFreshness(src(), new Date("2026-09-19T19:00:00Z"));
    const d = presentRefreshFreshness(src({ lastStatus: "failed" }), NOW);
    expect(worstFreshness([a, b, c, d])!.kind).toBe("failing");
    expect(worstFreshness([a, b, c])!.kind).toBe("stale");
    expect(worstFreshness([a, b])!.kind).toBe("running");
    expect(worstFreshness([])).toBeNull();
  });
});
