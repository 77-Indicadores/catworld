/** Estado observado dos workers para a API/tela: supervisor (heartbeat), filhos e carga por perfil. */
import { prisma } from "@/server/db";
import type { ChildSummary } from "@/supervisor/core";

/** Heartbeat mais velho que isso = sem supervisor (o supervisor bate a cada ~10 s). */
export const SUPERVISOR_ALIVE_MS = 45_000;

export type SupervisorStatus = {
  supervised: boolean;
  instanceId: string | null;
  hostname: string | null;
  pid: number | null;
  heartbeatAt: string | null;
  children: ChildSummary[];
};

export async function getSupervisorStatus(): Promise<SupervisorStatus> {
  const rows = await prisma.$queryRawUnsafe<{ instance_id: string; hostname: string | null; pid: number | null; heartbeat_at: Date; children_json: string | null; alive: boolean }[]>(
    `SELECT instance_id, hostname, pid, heartbeat_at, children_json,
            heartbeat_at > NOW() - ($1 || ' milliseconds')::interval AS alive
     FROM cw_supervisor_state ORDER BY heartbeat_at DESC LIMIT 1`,
    String(SUPERVISOR_ALIVE_MS),
  );
  const r = rows[0];
  if (!r) return { supervised: false, instanceId: null, hostname: null, pid: null, heartbeatAt: null, children: [] };
  let children: ChildSummary[] = [];
  try {
    children = r.children_json ? (JSON.parse(r.children_json) as ChildSummary[]) : [];
  } catch {
    children = [];
  }
  return { supervised: r.alive, instanceId: r.instance_id, hostname: r.hostname, pid: r.pid, heartbeatAt: r.heartbeat_at.toISOString(), children: r.alive ? children : [] };
}

export type ProfileLoad = { runningJobs: number; queuedJobs: number };

/** Jobs em execução (pelo rótulo `<perfil>-N@host`) e na fila (pelos tipos do perfil), por perfil. */
export async function getProfileLoad(profiles: { name: string; jobTypes: string[] }[]): Promise<Map<string, ProfileLoad>> {
  const out = new Map<string, ProfileLoad>();
  for (const p of profiles) {
    // nome do perfil só tem [a-z0-9-]: seguro dentro de regex; o ^...-N@ evita casar o prefixo de outro perfil (a x a-b)
    const [running] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*)::bigint AS n FROM cw_jobs WHERE status = 'RUNNING' AND locked_by ~ $1`,
      `^${p.name}-[0-9]+@`,
    );
    const [queued] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*)::bigint AS n FROM cw_jobs WHERE status = 'QUEUED' AND type = ANY($1::text[])`,
      p.jobTypes,
    );
    out.set(p.name, { runningJobs: Number(running?.n ?? 0), queuedJobs: Number(queued?.n ?? 0) });
  }
  return out;
}
