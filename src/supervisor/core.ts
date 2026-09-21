/**
 * Núcleo do supervisor: reconcilia perfis (estado desejado, no banco) com processos filhos (estado observado) e
 * executa os comandos da tela. Sem I/O próprio: banco, criação de processo e relógio são injetados, então tudo aqui
 * é testável com filhos e tempo falsos.
 */
import { needsRestart } from "@/server/worker/profiles";
import type { CommandAction, CommandMode, CommandStatus } from "@/server/worker/commands";

export type SlotState = "STARTING" | "RUNNING" | "DRAINING" | "BACKOFF" | "CRASH_LOOP" | "STOPPED";

export type ChildHandle = {
  pid: number | undefined;
  send(message: unknown): void;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
  onExit(cb: (code: number | null, signal: string | null) => void): void;
};

export type CoreProfile = { id: string; name: string; enabled: boolean; revision: number; jobTypes: string[]; concurrency: number; weights?: number[] };
export type CoreCommand = { id: string; action: CommandAction; mode: CommandMode; profileId: string | null; timeoutMs: number };
export type CoreConfig = { stopTimeoutMs: number; backoffMaxMs: number };

export type ChildSummary = {
  profileId: string;
  name: string;
  pid: number | null;
  state: SlotState;
  restarts: number;
  lastExitCode: number | null;
  lastExitAt: number | null;
  startedAt: number | null;
  restartPending: boolean;
  backoffUntil: number | null;
};

export interface CoreDb {
  loadProfiles(): Promise<CoreProfile[]>;
  loadConfig(): Promise<CoreConfig>;
  /** PENDING mais antigo -> ACCEPTED, de forma atômica; null se não há. */
  claimCommand(): Promise<CoreCommand | null>;
  updateCommand(id: string, status: CommandStatus, result?: Record<string, unknown>): Promise<void>;
  setProfileEnabled(id: string, enabled: boolean): Promise<void>;
  expireStale(): Promise<void>;
  heartbeat(children: ChildSummary[]): Promise<void>;
  audit(eventType: string, resourceId: string, detail: Record<string, unknown>, success: boolean): Promise<void>;
  /** Jobs ainda RUNNING deste perfil (para dizer quem foi afetado quando o worker cai). Opcional. */
  runningJobs?(profileName: string): Promise<{ id: string; type: string; attempts: number }[]>;
}

export type CoreDeps = {
  db: CoreDb;
  spawn: (profile: CoreProfile) => ChildHandle;
  now: () => number;
  /** Chamado quando o supervisor deve encerrar o processo (RESTART_SUPERVISOR concluído). */
  exit: (code: number) => void;
  log?: (msg: string) => void;
};

const STABLE_MS = 60_000; // filho que viveu isso zera o contador de quedas
const CRASH_LOOP_AFTER = 5;
const RUNNING_AFTER_MS = 2_000;
const SIGKILL_AFTER_MS = 30_000;
const IMMEDIATE_KILL_AFTER_MS = 10_000;
const HEARTBEAT_EVERY_MS = 10_000;
const EXPIRE_EVERY_MS = 60_000;

type Slot = {
  profile: CoreProfile;
  child: ChildHandle | null;
  state: SlotState;
  spawned: { jobTypes: string[]; concurrency: number; weights?: number[] } | null;
  startedAt: number | null;
  spawnCount: number;
  crashes: number;
  backoffUntil: number | null;
  lastExitCode: number | null;
  lastExitAt: number | null;
  draining: boolean;
  drainDeadline: number | null;
  termSent: boolean;
  killAt: number | null;
  forced: boolean;
};

type Target = { name: string; old: ChildHandle | null };
type ActiveCommand = { cmd: CoreCommand; kind: "restart" | "stop" | "start" | "supervisor"; targets: Target[]; forced: boolean };

export class Supervisor {
  private slots = new Map<string, Slot>();
  private active = new Map<string, ActiveCommand>();
  private shuttingDown = false;
  private lastHeartbeat = 0;
  private lastExpire = 0;
  private cfg: CoreConfig = { stopTimeoutMs: 600_000, backoffMaxMs: 60_000 };

  constructor(private deps: CoreDeps) {}

  private log(msg: string) {
    this.deps.log?.(msg);
  }

  /** Um ciclo do loop de reconciliação. Nunca lança por falha de banco: registra e tenta no próximo. */
  async tick(): Promise<void> {
    const now = this.deps.now();
    try {
      this.cfg = await this.deps.db.loadConfig();
      const profiles = await this.deps.db.loadProfiles();
      this.reconcile(profiles, now);
      await this.processCommands(now);
      this.enforceDeadlines(now);
      await this.finishCommands();
      if (now - this.lastHeartbeat >= HEARTBEAT_EVERY_MS) {
        this.lastHeartbeat = now;
        await this.deps.db.heartbeat(this.summaries());
      }
      if (now - this.lastExpire >= EXPIRE_EVERY_MS) {
        this.lastExpire = now;
        await this.deps.db.expireStale();
      }
    } catch (e) {
      this.log(`tick falhou (transiente): ${e instanceof Error ? e.message : e}`);
    }
  }

  summaries(): ChildSummary[] {
    return [...this.slots.values()].map((s) => ({
      profileId: s.profile.id,
      name: s.profile.name,
      pid: s.child?.pid ?? null,
      state: s.state,
      restarts: Math.max(0, s.spawnCount - 1),
      lastExitCode: s.lastExitCode,
      lastExitAt: s.lastExitAt,
      startedAt: s.startedAt,
      restartPending: !!s.child && !!s.spawned && needsRestart(s.spawned, s.profile),
      backoffUntil: s.backoffUntil,
    }));
  }

  hasChildren(): boolean {
    return [...this.slots.values()].some((s) => s.child);
  }

  /** SIGTERM do próprio supervisor: drena todos (respeitando o prazo) e não sobe mais nada. */
  beginShutdown(timeoutMs: number): void {
    this.shuttingDown = true;
    for (const s of this.slots.values()) if (s.child) this.beginDrain(s, "SAFE", timeoutMs, this.deps.now());
  }

  // ---------------------------------------------------------------- reconcile

  private reconcile(profiles: CoreProfile[], now: number) {
    const seen = new Set<string>();
    for (const p of profiles) {
      seen.add(p.name);
      let slot = this.slots.get(p.name);
      if (!slot) {
        slot = this.newSlot(p);
        this.slots.set(p.name, slot);
      }
      slot.profile = p;
      if (slot.state === "STARTING" && slot.child && slot.startedAt !== null && now - slot.startedAt >= RUNNING_AFTER_MS) slot.state = "RUNNING";
      if (!p.enabled) {
        if (slot.child && !slot.draining) this.beginDrain(slot, "SAFE", this.cfg.stopTimeoutMs, now);
        if (!slot.child) slot.state = "STOPPED";
        continue;
      }
      if (slot.child || this.shuttingDown) continue;
      if (slot.backoffUntil !== null && now < slot.backoffUntil) continue;
      this.spawnSlot(slot, now);
    }
    // perfil apagado: drena o que estiver rodando
    for (const [name, slot] of this.slots) {
      if (seen.has(name)) continue;
      if (slot.child && !slot.draining) this.beginDrain(slot, "SAFE", this.cfg.stopTimeoutMs, now);
      if (!slot.child) this.slots.delete(name);
    }
  }

  private newSlot(profile: CoreProfile): Slot {
    return {
      profile, child: null, state: "STOPPED", spawned: null, startedAt: null, spawnCount: 0, crashes: 0, backoffUntil: null,
      lastExitCode: null, lastExitAt: null, draining: false, drainDeadline: null, termSent: false, killAt: null, forced: false,
    };
  }

  private spawnSlot(slot: Slot, now: number) {
    const child = this.deps.spawn(slot.profile);
    slot.child = child;
    slot.state = "STARTING";
    slot.startedAt = now;
    slot.backoffUntil = null;
    slot.draining = false;
    slot.drainDeadline = null;
    slot.termSent = false;
    slot.killAt = null;
    slot.spawnCount++;
    slot.spawned = { jobTypes: [...slot.profile.jobTypes], concurrency: slot.profile.concurrency, weights: [...(slot.profile.weights ?? [])] };
    child.onExit((code, signal) => this.onChildExit(slot, child, code, signal));
    this.log(`worker ${slot.profile.name} iniciado (pid ${child.pid})`);
    void this.deps.db.audit("WORKER_STARTED", slot.profile.name, { pid: child.pid ?? null, restarts: slot.spawnCount - 1 }, true).catch(() => undefined);
  }

  private onChildExit(slot: Slot, child: ChildHandle, code: number | null, signal: string | null) {
    if (slot.child !== child) return;
    const now = this.deps.now();
    const uptime = slot.startedAt === null ? 0 : now - slot.startedAt;
    const requested = slot.draining;
    slot.child = null;
    slot.lastExitCode = code;
    slot.lastExitAt = now;
    slot.draining = false;
    slot.drainDeadline = null;
    slot.termSent = false;
    slot.killAt = null;
    if (requested) {
      // saída pedida por nós (reinício/parada/desabilitado): sem backoff; sobe de novo já se ainda deve rodar
      slot.crashes = 0;
      slot.backoffUntil = null;
      slot.state = "STOPPED";
      return;
    }
    if (code === 0 && uptime >= RUNNING_AFTER_MS * 2.5) {
      // saída limpa por iniciativa do próprio worker (ex.: perfil desabilitado, IPC caiu): não é queda
      slot.crashes = 0;
      slot.state = "STOPPED";
      return;
    }
    slot.crashes = uptime >= STABLE_MS ? 1 : slot.crashes + 1;
    const delay = Math.min(1000 * 2 ** (slot.crashes - 1), this.cfg.backoffMaxMs);
    slot.backoffUntil = now + delay;
    slot.state = slot.crashes >= CRASH_LOOP_AFTER ? "CRASH_LOOP" : "BACKOFF";
    this.log(`worker ${slot.profile.name} caiu (code ${code}, signal ${signal}); nova tentativa em ${Math.round(delay / 1000)}s`);
    // Registra QUEM foi afetado: os jobs que estavam RUNNING neste perfil (serão recolocados na fila). Sem isso a queda era só um número.
    const crashed = slot.profile.name;
    const base = { code, signal, uptimeMs: uptime, crashes: slot.crashes, retryInMs: delay };
    void (async () => {
      const jobs = await this.deps.db.runningJobs?.(crashed).catch(() => undefined);
      await this.deps.db.audit("WORKER_CRASHED", crashed, jobs && jobs.length ? { ...base, affectedJobs: jobs } : base, false);
    })().catch(() => undefined);
  }

  private beginDrain(slot: Slot, mode: CommandMode, timeoutMs: number, now: number) {
    if (!slot.child) return;
    slot.state = "DRAINING";
    slot.draining = true;
    if (mode === "IMMEDIATE") {
      if (!slot.termSent) {
        slot.child.kill("SIGTERM");
        slot.termSent = true;
        slot.killAt = now + IMMEDIATE_KILL_AFTER_MS;
      }
      return;
    }
    if (slot.drainDeadline === null) {
      slot.child.send({ type: "drain" });
      slot.drainDeadline = now + timeoutMs;
    }
  }

  private enforceDeadlines(now: number) {
    for (const slot of this.slots.values()) {
      if (!slot.child || !slot.draining) continue;
      if (!slot.termSent && slot.drainDeadline !== null && now >= slot.drainDeadline) {
        slot.child.kill("SIGTERM");
        slot.termSent = true;
        slot.forced = true;
        slot.killAt = now + SIGKILL_AFTER_MS;
        for (const a of this.active.values()) if (a.targets.some((t) => t.name === slot.profile.name)) a.forced = true;
        this.log(`worker ${slot.profile.name}: prazo de drenagem esgotado, forçando parada`);
      }
      if (slot.termSent && slot.killAt !== null && now >= slot.killAt) {
        slot.child.kill("SIGKILL");
        slot.killAt = now + SIGKILL_AFTER_MS; // reenvia se o kill não pegar
      }
    }
  }

  // ---------------------------------------------------------------- comandos

  private async processCommands(now: number) {
    for (let i = 0; i < 5; i++) {
      const cmd = await this.deps.db.claimCommand();
      if (!cmd) return;
      try {
        await this.startCommand(cmd, now);
      } catch (e) {
        await this.deps.db.updateCommand(cmd.id, "FAILED", { error: e instanceof Error ? e.message : String(e) });
        await this.deps.db.audit("WORKER_COMMAND_FAILED", cmd.id, { action: cmd.action, mode: cmd.mode, profileId: cmd.profileId, error: e instanceof Error ? e.message : String(e) }, false).catch(() => undefined);
      }
    }
  }

  private slotById(profileId: string | null): Slot | undefined {
    return [...this.slots.values()].find((s) => s.profile.id === profileId);
  }

  private async startCommand(cmd: CoreCommand, now: number) {
    await this.deps.db.audit("WORKER_COMMAND_STARTED", cmd.id, { action: cmd.action, mode: cmd.mode, profileId: cmd.profileId }, true).catch(() => undefined);

    if (cmd.action === "RESTART_PROFILE") {
      const slot = this.slotById(cmd.profileId);
      if (!slot) throw new Error("perfil não encontrado");
      if (!slot.profile.enabled) throw new Error("perfil desabilitado: habilite antes de reiniciar");
      if (!slot.child) {
        // parado ou em backoff: "reiniciar" = subir agora
        slot.backoffUntil = null;
        if (!this.shuttingDown) this.spawnSlot(slot, now);
        await this.deps.db.updateCommand(cmd.id, "DONE", { note: "estava parado; iniciado" });
        return;
      }
      this.beginDrain(slot, cmd.mode, cmd.timeoutMs, now);
      this.active.set(cmd.id, { cmd, kind: "restart", targets: [{ name: slot.profile.name, old: slot.child }], forced: false });
      await this.deps.db.updateCommand(cmd.id, "DRAINING");
      return;
    }

    if (cmd.action === "STOP_PROFILE") {
      const slot = this.slotById(cmd.profileId);
      if (!slot) throw new Error("perfil não encontrado");
      await this.deps.db.setProfileEnabled(slot.profile.id, false);
      await this.deps.db.audit("WORKER_PROFILE_UPDATED", slot.profile.name, { name: slot.profile.name, fields: ["enabled"], enabled: false, via: cmd.id }, true).catch(() => undefined);
      slot.profile = { ...slot.profile, enabled: false };
      if (!slot.child) {
        await this.deps.db.updateCommand(cmd.id, "DONE", { note: "já estava parado" });
        return;
      }
      this.beginDrain(slot, cmd.mode, cmd.timeoutMs, now);
      this.active.set(cmd.id, { cmd, kind: "stop", targets: [{ name: slot.profile.name, old: slot.child }], forced: false });
      await this.deps.db.updateCommand(cmd.id, "DRAINING");
      return;
    }

    if (cmd.action === "START_PROFILE") {
      const slot = this.slotById(cmd.profileId);
      if (!slot) throw new Error("perfil não encontrado");
      await this.deps.db.setProfileEnabled(slot.profile.id, true);
      await this.deps.db.audit("WORKER_PROFILE_UPDATED", slot.profile.name, { name: slot.profile.name, fields: ["enabled"], enabled: true, via: cmd.id }, true).catch(() => undefined);
      slot.profile = { ...slot.profile, enabled: true };
      slot.backoffUntil = null;
      if (!slot.child && !this.shuttingDown) this.spawnSlot(slot, now);
      await this.deps.db.updateCommand(cmd.id, "DONE");
      return;
    }

    if (cmd.action === "RESTART_ALL") {
      const targets: Target[] = [];
      for (const slot of this.slots.values()) {
        if (!slot.profile.enabled) continue;
        if (slot.child) {
          this.beginDrain(slot, cmd.mode, cmd.timeoutMs, now);
          targets.push({ name: slot.profile.name, old: slot.child });
        } else {
          slot.backoffUntil = null; // em backoff: sobe já
        }
      }
      if (targets.length === 0) {
        await this.deps.db.updateCommand(cmd.id, "DONE", { note: "nenhum worker em execução" });
        return;
      }
      this.active.set(cmd.id, { cmd, kind: "restart", targets, forced: false });
      await this.deps.db.updateCommand(cmd.id, "DRAINING");
      return;
    }

    if (cmd.action === "RESTART_SUPERVISOR") {
      this.shuttingDown = true;
      const targets: Target[] = [];
      for (const slot of this.slots.values()) {
        if (!slot.child) continue;
        this.beginDrain(slot, cmd.mode, cmd.timeoutMs, now);
        targets.push({ name: slot.profile.name, old: slot.child });
      }
      this.active.set(cmd.id, { cmd, kind: "supervisor", targets, forced: false });
      await this.deps.db.updateCommand(cmd.id, targets.length ? "DRAINING" : "APPLYING");
      return;
    }

    throw new Error(`ação desconhecida: ${String(cmd.action)}`);
  }

  private async finishCommands() {
    for (const [id, a] of [...this.active]) {
      const done = a.targets.every((t) => {
        const slot = this.slots.get(t.name);
        if (a.kind === "restart") return !!slot?.child && slot.child !== t.old;
        return !slot?.child; // stop / supervisor: terminou quando saiu
      });
      if (!done) continue;
      this.active.delete(id);
      const status: CommandStatus = a.forced ? "FORCED" : "DONE";
      await this.deps.db.updateCommand(id, status, { targets: a.targets.map((t) => t.name), forced: a.forced }).catch(() => undefined);
      await this.deps.db.audit("WORKER_COMMAND_COMPLETED", id, { action: a.cmd.action, status, forced: a.forced }, true).catch(() => undefined);
      if (a.kind === "supervisor") this.deps.exit(0);
    }
  }
}
