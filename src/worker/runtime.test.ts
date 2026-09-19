import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db", () => ({ prisma: {} }));

import { LIVENESS_FRESH_MS, WorkerState, assertKnownTypes, identityConflict, parseLiveness, parseProfileArg } from "./runtime";

describe("parseProfileArg", () => {
  it("aceita --profile nome e --profile=nome", () => {
    expect(parseProfileArg(["node", "x", "--profile", "worker-sync"])).toBe("worker-sync");
    expect(parseProfileArg(["--profile=uploads"])).toBe("uploads");
  });
  it("ausente ou sem valor: null", () => {
    expect(parseProfileArg(["node", "x"])).toBeNull();
    expect(parseProfileArg(["--profile"])).toBeNull();
    expect(parseProfileArg(["--profile", "--outro"])).toBeNull();
    expect(parseProfileArg(["--profile="])).toBeNull();
  });
});

describe("assertKnownTypes (o claim interpola tipos no SQL)", () => {
  it("aceita os conhecidos e recusa qualquer outra coisa", () => {
    expect(assertKnownTypes(["IMPORT_UPLOAD"])).toEqual(["IMPORT_UPLOAD"]);
    expect(() => assertKnownTypes(["IMPORT_UPLOAD", "x') OR 1=1 --"])).toThrow(/inválidos/);
    expect(() => assertKnownTypes([])).toThrow();
  });
});

describe("WorkerState (drenagem)", () => {
  it("normal: pode pegar job; drenando: não pega e só termina quando o último job acaba", () => {
    const s = new WorkerState();
    expect(s.canClaim).toBe(true);
    s.jobStarted(); s.jobStarted();
    s.draining = true;
    expect(s.canClaim).toBe(false);
    expect(s.finished).toBe(false);
    s.jobFinished();
    expect(s.finished).toBe(false);
    s.jobFinished();
    expect(s.finished).toBe(true);
  });
  it("SIGTERM (stopping) também para de pegar job; contador nunca fica negativo", () => {
    const s = new WorkerState();
    s.stopping = true;
    expect(s.canClaim).toBe(false);
    expect(s.finished).toBe(true);
    s.jobFinished();
    expect(s.inflight).toBe(0);
  });
  it("sem drenar nem parar nunca está 'finished', mesmo ocioso", () => {
    expect(new WorkerState().finished).toBe(false);
  });
});

describe("guarda de identidade (dois workers com o mesmo rótulo)", () => {
  const me = { host: "h1", pid: 10 };
  const now = Date.parse("2026-09-19T12:00:30.000Z");
  const fresh = "2026-09-19T12:00:20.000Z";
  const stale = "2026-09-19T11:58:00.000Z";
  const alive = () => true;
  const dead = () => false;

  it("sem pulsação ou pulsação velha: livre", () => {
    expect(identityConflict(undefined, me, now, alive)).toBe(false);
    expect(identityConflict(`${stale}|h2|99`, me, now, alive)).toBe(false);
  });
  it("mesmo processo: livre; mesmo host com pid morto (respawn após crash): livre", () => {
    expect(identityConflict(`${fresh}|h1|10`, me, now, alive)).toBe(false);
    expect(identityConflict(`${fresh}|h1|77`, me, now, dead)).toBe(false);
  });
  it("mesmo host com pid vivo, ou outro host com pulsação fresca: conflito", () => {
    expect(identityConflict(`${fresh}|h1|77`, me, now, alive)).toBe(true);
    expect(identityConflict(`${fresh}|h2|5`, me, now, dead)).toBe(true);
  });
  it("formato antigo (só horário) e recente: assume vivo", () => {
    expect(identityConflict(fresh, me, now, dead)).toBe(true);
  });
  it("parseLiveness e a janela de frescor", () => {
    expect(parseLiveness(`${fresh}|h2|5`)).toMatchObject({ host: "h2", pid: 5 });
    expect(parseLiveness("lixo").at).toBe(0);
    expect(LIVENESS_FRESH_MS).toBeGreaterThan(15_000);
  });
});
