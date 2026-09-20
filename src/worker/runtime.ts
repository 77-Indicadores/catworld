/**
 * Runtime do processo worker: identidade (perfil vindo do banco), estado de drenagem e guarda de identidade.
 * Sem variável de ambiente: o perfil é escolhido por `--profile <nome>` (o supervisor passa isso) e todo o resto vem
 * do banco. Lógica pura aqui (testável); o `index.ts` só liga isso ao loop.
 */
import { prisma } from "@/server/db";
import { KNOWN_JOB_TYPES, type JobType } from "@/server/worker/profiles";

export type WorkerProfileRow = {
  id: string;
  name: string;
  jobTypes: JobType[];
  /** Faixa: só pega jobs destes pesos; vazio = qualquer peso. */
  weights: number[];
  concurrency: number;
  pollMs: number;
  duckdbMemoryLimit: string;
  enabled: boolean;
  revision: number;
};

/** `--profile nome` ou `--profile=nome`; null se ausente. */
export function parseProfileArg(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--profile") return argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : null;
    if (a.startsWith("--profile=")) return a.slice("--profile=".length) || null;
  }
  return null;
}

/** Tipos vindos do banco só chegam ao `claim` (que os interpola no SQL) depois desta checagem. */
export function assertKnownTypes(types: string[]): JobType[] {
  const bad = types.filter((t) => !(KNOWN_JOB_TYPES as readonly string[]).includes(t));
  if (bad.length || types.length === 0) throw new Error(`Tipos de job inválidos no perfil: ${bad.join(", ") || "(vazio)"}`);
  return types as JobType[];
}

/**
 * Estado de parada do worker:
 *  - stopping: SIGTERM/SIGINT (termina o job em andamento e sai);
 *  - draining: pedido do supervisor (IPC) ou perfil desabilitado — não pega job novo, termina os em andamento e sai.
 */
export class WorkerState {
  stopping = false;
  draining = false;
  inflight = 0;

  /** Pode pegar um job novo? */
  get canClaim(): boolean {
    return !this.stopping && !this.draining;
  }

  jobStarted(): void {
    this.inflight++;
  }

  jobFinished(): void {
    this.inflight = Math.max(0, this.inflight - 1);
  }

  /** Nada mais a fazer: parando/drenando e sem job em andamento. */
  get finished(): boolean {
    return !this.canClaim && this.inflight === 0;
  }
}

export type Liveness = { at: number; host: string | null; pid: number | null };

/** `2026-09-19T04:22:18.313Z|host|pid` (formato antigo, só o horário, também é aceito). */
export function parseLiveness(raw: string): Liveness {
  const [ts, host, pid] = raw.split("|");
  const at = Date.parse(ts ?? "");
  return { at: Number.isNaN(at) ? 0 : at, host: host ?? null, pid: pid ? Number(pid) : null };
}

export const LIVENESS_FRESH_MS = 45_000;

/**
 * Já existe OUTRO processo vivo com esta identidade? Pulsação recente de outro host, ou de outro pid ainda vivo no
 * mesmo host. Evita dois workers com o mesmo rótulo se reenfileirando (`releaseSelf`) um ao outro.
 */
export function identityConflict(
  raw: string | undefined,
  me: { host: string; pid: number },
  now: number,
  isPidAlive: (pid: number) => boolean,
): boolean {
  if (!raw) return false;
  const l = parseLiveness(raw);
  if (now - l.at > LIVENESS_FRESH_MS) return false;
  if (l.host === null || l.pid === null) return true; // formato antigo e recente: assume vivo
  if (l.host === me.host && l.pid === me.pid) return false;
  if (l.host === me.host) return isPidAlive(l.pid);
  return true; // outro host com pulsação fresca
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function loadProfile(name: string): Promise<WorkerProfileRow | null> {
  const p = await prisma.workerProfile.findUnique({ where: { name } });
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    jobTypes: assertKnownTypes(p.jobTypes),
    weights: p.weights ?? [],
    concurrency: p.concurrency,
    pollMs: p.pollMs,
    duckdbMemoryLimit: p.duckdbMemoryLimit,
    enabled: p.enabled,
    revision: p.revision,
  };
}

export async function listProfileNames(): Promise<string[]> {
  return (await prisma.workerProfile.findMany({ select: { name: true }, orderBy: { name: "asc" } })).map((p) => p.name);
}
