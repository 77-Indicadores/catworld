import { describe, expect, it } from "vitest";
import { presentRefreshFreshness, presentTableFreshness, type RefreshInput } from "@/lib/present";
import { freshnessHeadline, summarizeFreshness, type FreshnessItem } from "./summary";

const NOW = new Date("2026-09-19T17:30:00Z");
const base: RefreshInput = { mode: "extract", active: true, lastStatus: "completed", lastError: null, refreshCron: "0 * * * *", nextRefreshAt: "2026-09-19T18:00:00Z", lastRefreshedAt: "2026-09-19T17:00:00Z" };
const item = (name: string, over: Partial<RefreshInput>): FreshnessItem => ({ key: name, name, group: "DS", freshness: presentRefreshFreshness({ ...base, ...over }, NOW) });
const upload = (name: string): FreshnessItem => ({ key: name, name, group: "DS", freshness: presentTableFreshness({ lastDataAt: "2026-01-01T00:00:00Z", sources: [] }, NOW) });

describe("summarizeFreshness / freshnessHeadline", () => {
  it("separa erro, atrasada, atualizando, em dia e neutra", () => {
    const s = summarizeFreshness([
      item("a", { lastStatus: "failed", lastError: "x" }),
      item("b", { nextRefreshAt: "2026-09-19T15:00:00Z" }),
      item("c", { lastStatus: "running" }),
      item("d", {}),
      upload("e"),
      item("f", { active: false }),
    ]);
    expect(s).toMatchObject({ total: 6, healthy: 1, neutral: 1, paused: 1 });
    expect(s.failing.map((i) => i.name)).toEqual(["a"]);
    expect(s.stale.map((i) => i.name)).toEqual(["b"]);
    expect(s.running.map((i) => i.name)).toEqual(["c"]);
  });
  it("selo: erro > atrasada > atualizando > em dia", () => {
    expect(freshnessHeadline(summarizeFreshness([item("a", { lastStatus: "failed" }), item("b", { nextRefreshAt: "2026-09-19T15:00:00Z" })]))).toEqual({ tone: "error", label: "1 com erro" });
    expect(freshnessHeadline(summarizeFreshness([item("b", { nextRefreshAt: "2026-09-19T15:00:00Z" }), item("c", { nextRefreshAt: "2026-09-19T15:00:00Z" })]))).toEqual({ tone: "warning", label: "2 atrasadas" });
    expect(freshnessHeadline(summarizeFreshness([item("c", { lastStatus: "running" })]))).toEqual({ tone: "warning", label: "Atualizando" });
    expect(freshnessHeadline(summarizeFreshness([item("d", {}), upload("u")]))).toEqual({ tone: "healthy", label: "Em dia" });
  });
  it("só upload (sem agenda) não é 'Em dia': é 'Sem agenda'; sem tabelas é 'Sem tabelas'", () => {
    expect(freshnessHeadline(summarizeFreshness([upload("u")]))).toEqual({ tone: "inactive", label: "Sem agenda" });
    expect(freshnessHeadline(summarizeFreshness([]))).toEqual({ tone: "inactive", label: "Sem tabelas" });
  });
});
