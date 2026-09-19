/**
 * Supervisor de workers (`npm run supervisor` / container `workers`).
 *
 * Lê os perfis do banco, sobe um processo worker por perfil habilitado, reinicia o que cair (com backoff) e executa
 * os comandos da tela (reiniciar com segurança / agora). Só um supervisor ativo por banco (advisory lock); um segundo
 * fica em standby. Env necessário: só o compartilhado (CATWORLD_DATABASE_URL, ENCRYPTION_KEY, AUTH_SECRET, UPLOAD_DIR).
 */
import { fork } from "node:child_process";
import { hostname } from "node:os";
import { resolve } from "node:path";
import pg from "pg";
import { prisma } from "@/server/db";
import { env } from "@/server/env";
import { Supervisor, type ChildHandle, type CoreProfile } from "./core";
import { createCoreDb } from "./db";

const TICK_MS = 3000;
const STANDBY_RETRY_MS = 10_000;
const LOCK_NAME = "catworld.supervisor";
const WORKER_ENTRY = resolve(process.cwd(), "src/worker/index.ts");

const instanceId = `${hostname()}-${process.pid}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function spawnWorker(profile: CoreProfile): ChildHandle {
  const child = fork(WORKER_ENTRY, ["--profile", profile.name], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    env: process.env,
  });
  return {
    get pid() { return child.pid; },
    send: (m) => { if (child.connected) child.send(m as never); },
    kill: (sig) => { child.kill(sig); },
    onExit: (cb) => { child.on("exit", (code, signal) => cb(code, signal)); },
  };
}

/** Lock de sessão numa conexão dedicada (o pool do Prisma poderia trocar de conexão e soltá-lo). */
async function acquireLeadership(): Promise<pg.Client | null> {
  const url = process.env.CATWORLD_DATABASE_URL;
  if (!url) throw new Error("CATWORLD_DATABASE_URL ausente");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const r = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [LOCK_NAME]);
  if (r.rows[0]?.ok) return client;
  await client.end().catch(() => undefined);
  return null;
}

async function main() {
  env(); // falha cedo se faltar env de infraestrutura e avisa (uma vez) sobre envs de worker legadas ignoradas
  console.log(`[supervisor] ${instanceId} iniciando`);
  let lock: pg.Client | null = null;
  while (!lock) {
    lock = await acquireLeadership().catch((e) => { console.error("[supervisor] lock falhou:", e instanceof Error ? e.message : e); return null; });
    if (!lock) {
      console.log("[supervisor] outro supervisor está ativo: standby");
      await sleep(STANDBY_RETRY_MS);
    }
  }
  // Perdeu a conexão do lock = perdeu a liderança: sai e o Docker reinicia (evita dois supervisores).
  let finishingRef = () => false;
  lock.on("error", () => { if (finishingRef()) return; console.error("[supervisor] conexão do lock caiu; saindo"); process.exit(1); });
  lock.on("end", () => { if (finishingRef()) return; console.error("[supervisor] conexão do lock encerrou; saindo"); process.exit(1); });

  const db = createCoreDb(instanceId);
  const orphaned = await db.failOrphanedCommands();
  if (orphaned > 0) console.log(`[supervisor] ${orphaned} comando(s) em andamento do supervisor anterior marcados como FAILED`);

  const sup = new Supervisor({
    db,
    spawn: spawnWorker,
    now: () => Date.now(),
    exit: (code) => { void finish(code); },
    log: (m) => console.log(`[supervisor] ${m}`),
  });

  let stopping = false;
  let finishing = false; // encerramento deliberado: a queda da conexão do lock não é erro
  async function finish(code: number) {
    finishing = true;
    await db.clearLiveness().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    await lock?.end().catch(() => undefined);
    process.exit(code);
  }

  finishingRef = () => finishing;

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    const cfg = await db.loadConfig().catch(() => ({ stopTimeoutMs: 600_000, backoffMaxMs: 60_000 }));
    console.log(`[supervisor] ${signal}: drenando workers (até ${Math.round(cfg.stopTimeoutMs / 1000)}s)`);
    sup.beginShutdown(cfg.stopTimeoutMs);
    while (sup.hasChildren()) {
      await sup.tick(); // continua aplicando prazos (SIGTERM/SIGKILL) enquanto espera
      await sleep(1000);
    }
    await finish(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  while (!stopping) {
    await sup.tick();
    await sleep(TICK_MS);
  }
  await sleep(60_000); // shutdown() conduz o encerramento
}

void main().catch((e) => { console.error("[supervisor] erro fatal:", e); process.exit(1); });
