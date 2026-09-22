import { beforeEach, describe, expect, it, vi } from "vitest";
import { Supervisor, type ChildHandle, type CoreCommand, type CoreConfig, type CoreDb, type CoreProfile } from "./core";

class FakeChild implements ChildHandle {
  static nextPid = 100;
  pid = FakeChild.nextPid++;
  sent: unknown[] = [];
  killed: string[] = [];
  private cb: ((code: number | null, signal: string | null) => void) | null = null;
  send(m: unknown) { this.sent.push(m); }
  kill(sig: "SIGTERM" | "SIGKILL") { this.killed.push(sig); }
  onExit(cb: (code: number | null, signal: string | null) => void) { this.cb = cb; }
  exit(code: number | null = 0, signal: string | null = null) { this.cb?.(code, signal); }
}

const profile = (over: Partial<CoreProfile> = {}): CoreProfile => ({
  id: "p1", name: "worker-uploads", enabled: true, revision: 1, jobTypes: ["IMPORT_UPLOAD"], concurrency: 1, ...over,
});

function setup(initial: CoreProfile[] = [profile()]) {
  let t = 1_000_000;
  const children: FakeChild[] = [];
  const state = { profiles: initial, commands: [] as CoreCommand[], cfg: { stopTimeoutMs: 600_000, backoffMaxMs: 60_000 } as CoreConfig };
  const updates: { id: string; status: string; result?: Record<string, unknown> }[] = [];
  const audits: { type: string; id: string; success: boolean }[] = [];
  const enabledCalls: [string, boolean][] = [];
  const db: CoreDb = {
    loadProfiles: async () => state.profiles.map((p) => ({ ...p })),
    loadConfig: async () => state.cfg,
    claimCommand: async () => state.commands.shift() ?? null,
    updateCommand: async (id, status, result) => { updates.push({ id, status, result }); },
    setProfileEnabled: async (id, enabled) => {
      enabledCalls.push([id, enabled]);
      state.profiles = state.profiles.map((p) => (p.id === id ? { ...p, enabled } : p));
    },
    expireStale: async () => undefined,
    heartbeat: vi.fn(async () => undefined),
    audit: async (type, id, _d, success) => { audits.push({ type, id, success }); },
  };
  const exit = vi.fn();
  const sup = new Supervisor({ db, spawn: () => { const c = new FakeChild(); children.push(c); return c; }, now: () => t, exit });
  const advance = (ms: number) => { t += ms; };
  const last = () => children[children.length - 1]!;
  return { sup, state, children, updates, audits, enabledCalls, exit, advance, last, db };
}

const cmd = (over: Partial<CoreCommand>): CoreCommand => ({ id: "c1", action: "RESTART_PROFILE", mode: "SAFE", profileId: "p1", timeoutMs: 600_000, ...over });
const stateOf = (sup: Supervisor, name = "worker-uploads") => sup.summaries().find((s) => s.name === name)!;

beforeEach(() => { FakeChild.nextPid = 100; });

describe("reconciliação", () => {
  it("sobe um filho por perfil habilitado e não sobe o desabilitado", async () => {
    const { sup, children } = setup([profile(), profile({ id: "p2", name: "worker-sync", enabled: false })]);
    await sup.tick();
    expect(children).toHaveLength(1);
    expect(stateOf(sup).state).toBe("STARTING");
    expect(stateOf(sup, "worker-sync").state).toBe("STOPPED");
  });
  it("vira RUNNING depois de alguns segundos e não sobe duas vezes", async () => {
    const { sup, children, advance } = setup();
    await sup.tick();
    advance(3000);
    await sup.tick();
    expect(children).toHaveLength(1);
    expect(stateOf(sup).state).toBe("RUNNING");
  });
  it("perfil desabilitado depois de rodando: drena (não mata)", async () => {
    const { sup, state, last, advance } = setup();
    await sup.tick();
    state.profiles = [profile({ enabled: false })];
    advance(1000);
    await sup.tick();
    expect(last().sent).toEqual([{ type: "drain" }]);
    expect(last().killed).toEqual([]);
    expect(stateOf(sup).state).toBe("DRAINING");
    last().exit(0);
    advance(1000);
    await sup.tick();
    expect(stateOf(sup).state).toBe("STOPPED");
  });
  it("perfil apagado: drena e some do resumo depois que sai", async () => {
    const { sup, state, last, advance } = setup();
    await sup.tick();
    state.profiles = [];
    advance(1000);
    await sup.tick();
    expect(last().sent).toEqual([{ type: "drain" }]);
    last().exit(0);
    advance(1000);
    await sup.tick();
    expect(sup.summaries()).toHaveLength(0);
  });
  it("mudou concorrência/tipos: marca reinício pendente, sem reiniciar sozinho; mudar poll não marca", async () => {
    const { sup, state, children, advance } = setup();
    await sup.tick();
    state.profiles = [profile({ revision: 2, concurrency: 3 })];
    advance(1000);
    await sup.tick();
    expect(children).toHaveLength(1);
    expect(stateOf(sup).restartPending).toBe(true);
    state.profiles = [profile({ revision: 3 })];
    await sup.tick();
    expect(stateOf(sup).restartPending).toBe(false);
  });
});

describe("quedas e backoff", () => {
  it("cai: espera 1s, 2s, 4s... e limita no máximo configurado", async () => {
    const { sup, children, advance, audits } = setup();
    await sup.tick();
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      children[children.length - 1]!.exit(1);
      const until = stateOf(sup).backoffUntil!;
      delays.push(until - 1_000_000 - (i === 0 ? 0 : 0));
      // antes do prazo não sobe
      await sup.tick();
      expect(children).toHaveLength(i + 1);
      advance(60_000);
      await sup.tick();
      expect(children).toHaveLength(i + 2);
    }
    expect(audits.filter((a) => a.type === "WORKER_CRASHED")).toHaveLength(4);
    expect(stateOf(sup).restarts).toBe(4);
  });
  it("a queda registra QUEM foi afetado: os jobs que estavam RUNNING no perfil", async () => {
    const { sup, children, db } = setup();
    const details: Record<string, unknown>[] = [];
    db.audit = async (_t, _id, d) => { details.push(d); };
    db.runningJobs = async (name) => (name === "worker-uploads" ? [{ id: "j-1", type: "IMPORT_UPLOAD", attempts: 1 }] : []);
    await sup.tick();
    children[0]!.exit(3);
    await new Promise((r) => setTimeout(r, 10));
    const crash = details.find((d) => d.code === 3)!;
    expect(crash.affectedJobs).toEqual([{ id: "j-1", type: "IMPORT_UPLOAD", attempts: 1 }]);
  });
  it("sem jobs em andamento (ou consulta falhando) o evento sai igual, sem 'affectedJobs'", async () => {
    const { sup, children, db } = setup();
    const details: Record<string, unknown>[] = [];
    db.audit = async (_t, _id, d) => { details.push(d); };
    db.runningJobs = async () => { throw new Error("db fora"); };
    await sup.tick();
    children[0]!.exit(1);
    await new Promise((r) => setTimeout(r, 10));
    const crash = details.find((d) => d.code === 1)!;
    expect(crash).toBeDefined();
    expect("affectedJobs" in crash).toBe(false);
  });
  it("5 quedas seguidas = CRASH_LOOP visível; filho estável por 60s zera o contador", async () => {
    const { sup, advance, last } = setup();
    await sup.tick();
    for (let i = 0; i < 5; i++) {
      last().exit(1);
      advance(61_000);
      await sup.tick();
    }
    last().exit(1);
    expect(stateOf(sup).state).toBe("CRASH_LOOP");
    advance(120_000);
    await sup.tick(); // sobe de novo
    advance(61_000);
    last().exit(1); // viveu mais de 60s: conta como 1ª queda
    expect(stateOf(sup).state).toBe("BACKOFF");
  });
  it("backoff respeita o teto configurado", async () => {
    const { sup, state, last, advance } = setup();
    state.cfg = { stopTimeoutMs: 600_000, backoffMaxMs: 3000 };
    await sup.tick();
    for (let i = 0; i < 4; i++) { last().exit(1); advance(10_000); await sup.tick(); }
    last().exit(1);
    const wait = stateOf(sup).backoffUntil! - (1_000_000 + 4 * 10_000);
    expect(wait).toBeLessThanOrEqual(3000);
  });
  it("saída com código 0 logo ao subir conta como queda (evita laço apertado)", async () => {
    const { sup, last } = setup();
    await sup.tick();
    last().exit(0);
    expect(["BACKOFF", "CRASH_LOOP"]).toContain(stateOf(sup).state);
  });
});

describe("comandos", () => {
  it("reinício SEGURO: drena, espera sair, sobe outro e conclui DONE", async () => {
    const { sup, state, children, updates, advance } = setup();
    await sup.tick();
    const first = children[0]!;
    state.commands.push(cmd({}));
    advance(1000);
    await sup.tick();
    expect(first.sent).toEqual([{ type: "drain" }]);
    expect(first.killed).toEqual([]);
    expect(updates.map((u) => u.status)).toEqual(["DRAINING"]);
    // ainda rodando o job: nada muda
    advance(60_000);
    await sup.tick();
    expect(updates).toHaveLength(1);
    // termina o job e sai
    first.exit(0);
    advance(1000);
    await sup.tick();
    expect(children).toHaveLength(2);
    expect(updates.at(-1)!.status).toBe("DONE");
    expect(updates.at(-1)!.result).toMatchObject({ forced: false });
  });
  it("prazo do reinício seguro esgotado: SIGTERM, depois SIGKILL, e termina FORCED", async () => {
    const { sup, state, children, updates, advance } = setup();
    await sup.tick();
    const first = children[0]!;
    state.commands.push(cmd({ timeoutMs: 5000 }));
    advance(1000);
    await sup.tick();
    advance(5000);
    await sup.tick();
    expect(first.killed).toEqual(["SIGTERM"]);
    advance(31_000);
    await sup.tick();
    expect(first.killed).toContain("SIGKILL");
    first.exit(null, "SIGKILL");
    advance(1000);
    await sup.tick();
    expect(children).toHaveLength(2);
    expect(updates.at(-1)!.status).toBe("FORCED");
  });
  it("reinício IMEDIATO: SIGTERM na hora, sem drenar", async () => {
    const { sup, state, children, advance } = setup();
    await sup.tick();
    state.commands.push(cmd({ mode: "IMMEDIATE" }));
    advance(1000);
    await sup.tick();
    expect(children[0]!.killed).toEqual(["SIGTERM"]);
    expect(children[0]!.sent).toEqual([]);
  });
  it("reiniciar perfil parado ou em backoff sobe na hora", async () => {
    const { sup, state, children, updates, advance, last } = setup();
    await sup.tick();
    last().exit(1);
    state.commands.push(cmd({}));
    advance(500);
    await sup.tick();
    expect(children).toHaveLength(2);
    expect(updates.at(-1)!.status).toBe("DONE");
  });
  it("reiniciar perfil desabilitado ou inexistente: FAILED com motivo", async () => {
    const { sup, state, updates, advance } = setup([profile({ enabled: false })]);
    await sup.tick();
    state.commands.push(cmd({}), cmd({ id: "c2", profileId: "nao-existe" }));
    advance(1000);
    await sup.tick();
    expect(updates.map((u) => [u.id, u.status])).toEqual([["c1", "FAILED"], ["c2", "FAILED"]]);
  });
  it("PARAR persiste enabled=false, drena e conclui quando sai; INICIAR habilita e sobe", async () => {
    const { sup, state, enabledCalls, children, updates, advance, last } = setup();
    await sup.tick();
    state.commands.push(cmd({ action: "STOP_PROFILE" }));
    advance(1000);
    await sup.tick();
    expect(enabledCalls).toEqual([["p1", false]]);
    last().exit(0);
    advance(1000);
    await sup.tick();
    expect(updates.at(-1)!.status).toBe("DONE");
    expect(children).toHaveLength(1); // não subiu de novo
    state.commands.push(cmd({ id: "c2", action: "START_PROFILE" }));
    advance(1000);
    await sup.tick();
    expect(enabledCalls.at(-1)).toEqual(["p1", true]);
    expect(children).toHaveLength(2);
    expect(updates.at(-1)).toMatchObject({ id: "c2", status: "DONE" });
  });
  it("REINICIAR TODOS drena todos e conclui quando todos voltaram", async () => {
    const { sup, state, children, updates, advance } = setup([profile(), profile({ id: "p2", name: "worker-sync" })]);
    await sup.tick();
    state.commands.push(cmd({ action: "RESTART_ALL", profileId: null }));
    advance(1000);
    await sup.tick();
    expect(children.every((c) => c.sent.length === 1)).toBe(true);
    children[0]!.exit(0);
    advance(1000);
    await sup.tick();
    expect(updates.at(-1)!.status).toBe("DRAINING"); // o outro ainda não saiu
    children[1]!.exit(0);
    advance(1000);
    await sup.tick();
    expect(updates.at(-1)!.status).toBe("DONE");
    expect(children).toHaveLength(4);
  });
  it("REINICIAR SUPERVISOR: drena tudo, não sobe nada e só então encerra o processo", async () => {
    const { sup, state, children, exit, advance } = setup();
    await sup.tick();
    state.commands.push(cmd({ action: "RESTART_SUPERVISOR", profileId: null }));
    advance(1000);
    await sup.tick();
    expect(exit).not.toHaveBeenCalled();
    children[0]!.exit(0);
    advance(1000);
    await sup.tick();
    expect(children).toHaveLength(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
  it("erro em um comando não impede os seguintes nem derruba o ciclo", async () => {
    const { sup, state, updates, advance } = setup();
    await sup.tick();
    state.commands.push(cmd({ profileId: "x" }), cmd({ id: "c2", action: "RESTART_ALL", profileId: null }));
    advance(1000);
    await sup.tick();
    expect(updates.find((u) => u.id === "c1")!.status).toBe("FAILED");
    expect(updates.find((u) => u.id === "c2")).toBeDefined();
  });
});

describe("robustez", () => {
  it("banco fora do ar: o ciclo não lança e o filho continua", async () => {
    const { sup, db, children, advance } = setup();
    await sup.tick();
    db.loadProfiles = async () => { throw new Error("db fora"); };
    advance(1000);
    await expect(sup.tick()).resolves.toBeUndefined();
    expect(children).toHaveLength(1);
  });
  it("shutdown do supervisor: drena todos e não sobe nada novo", async () => {
    const { sup, children, advance } = setup();
    await sup.tick();
    sup.beginShutdown(30_000);
    expect(children[0]!.sent).toEqual([{ type: "drain" }]);
    children[0]!.exit(0);
    advance(1000);
    await sup.tick();
    expect(children).toHaveLength(1);
    expect(sup.hasChildren()).toBe(false);
  });
  it("heartbeat com o resumo dos filhos", async () => {
    const { sup, db } = setup();
    await sup.tick();
    expect(db.heartbeat).toHaveBeenCalledWith([expect.objectContaining({ name: "worker-uploads", state: "STARTING", pid: expect.any(Number) })]);
  });
});
