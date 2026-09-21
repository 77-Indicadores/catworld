/** Acesso a dados do supervisor (Postgres via Prisma; comandos usam SKIP LOCKED para nunca executar duas vezes). */
import { hostname } from "node:os";
import { prisma } from "@/server/db";
import { SUPERVISOR_DEFAULTS, pickInt } from "@/server/worker/config";
import type { CommandAction, CommandMode, CommandStatus } from "@/server/worker/commands";
import { assertKnownTypes } from "@/worker/runtime";
import type { ChildSummary, CoreCommand, CoreConfig, CoreDb, CoreProfile } from "./core";

const TERMINAL = ["DONE", "FORCED", "FAILED", "CANCELLED", "EXPIRED"];
const ISO_NOW = `to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export function createCoreDb(instanceId: string): CoreDb & { failOrphanedCommands(): Promise<number>; clearLiveness(): Promise<void> } {
  return {
    async loadProfiles(): Promise<CoreProfile[]> {
      const rows = await prisma.workerProfile.findMany({ orderBy: { name: "asc" } });
      const out: CoreProfile[] = [];
      for (const r of rows) {
        try {
          out.push({ id: r.id, name: r.name, enabled: r.enabled, revision: r.revision, jobTypes: assertKnownTypes(r.jobTypes), weights: r.weights ?? [], concurrency: r.concurrency });
        } catch (e) {
          console.error(`[supervisor] perfil ${r.name} inválido, ignorado: ${e instanceof Error ? e.message : e}`);
        }
      }
      return out;
    },

    async loadConfig(): Promise<CoreConfig> {
      const rows = await prisma.$queryRawUnsafe<{ key: string; value: string }[]>(
        `SELECT key, value FROM cw_system_settings WHERE key IN ('worker.stop_timeout_ms','worker.backoff_max_ms')`,
      );
      const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      return {
        stopTimeoutMs: pickInt(m["worker.stop_timeout_ms"], SUPERVISOR_DEFAULTS.stop_timeout_ms, 1000, 3_600_000),
        backoffMaxMs: pickInt(m["worker.backoff_max_ms"], SUPERVISOR_DEFAULTS.backoff_max_ms, 1000, 600_000),
      };
    },

    async claimCommand(): Promise<CoreCommand | null> {
      const rows = await prisma.$queryRawUnsafe<{ id: string; action: CommandAction; mode: CommandMode; profile_id: string | null; timeout_ms: number }[]>(
        `UPDATE cw_system_commands SET status = 'ACCEPTED', started_at = NOW()
         WHERE id = (SELECT id FROM cw_system_commands WHERE status = 'PENDING' ORDER BY requested_at LIMIT 1 FOR UPDATE SKIP LOCKED)
         RETURNING id, action, mode, profile_id, timeout_ms`,
      );
      const r = rows[0];
      return r ? { id: r.id, action: r.action, mode: r.mode, profileId: r.profile_id, timeoutMs: r.timeout_ms } : null;
    },

    async updateCommand(id: string, status: CommandStatus, result?: Record<string, unknown>): Promise<void> {
      await prisma.$executeRawUnsafe(
        `UPDATE cw_system_commands
         SET status = $2, result_json = COALESCE($3, result_json),
             finished_at = CASE WHEN $2 = ANY($4::text[]) THEN NOW() ELSE finished_at END
         WHERE id = $1::uuid AND status <> ALL($4::text[])`,
        id, status, result ? JSON.stringify(result) : null, TERMINAL,
      );
    },

    async setProfileEnabled(id: string, enabled: boolean): Promise<void> {
      await prisma.workerProfile.update({ where: { id }, data: { enabled, revision: { increment: 1 } } });
    },

    async expireStale(): Promise<void> {
      await prisma.$executeRawUnsafe(
        `UPDATE cw_system_commands SET status = 'EXPIRED', finished_at = NOW(), result_json = '{"error":"expirou sem supervisor"}'
         WHERE status = 'PENDING' AND requested_at < NOW() - INTERVAL '1 hour'`,
      );
    },

    /** No boot: comandos que estavam em andamento quando o supervisor anterior morreu não continuam. */
    async failOrphanedCommands(): Promise<number> {
      const rows = await prisma.$queryRawUnsafe<{ id: string; action: string; mode: string }[]>(
        `UPDATE cw_system_commands SET status = 'FAILED', finished_at = NOW(), result_json = '{"error":"supervisor_restart"}'
         WHERE status IN ('ACCEPTED','DRAINING','APPLYING')
         RETURNING id, action, mode`,
      );
      for (const r of rows) {
        await this.audit("WORKER_COMMAND_FAILED", r.id, { action: r.action, mode: r.mode, error: "supervisor_restart" }, false).catch(() => undefined);
      }
      return rows.length;
    },

    async heartbeat(children: ChildSummary[]): Promise<void> {
      await prisma.$executeRawUnsafe(
        `INSERT INTO cw_supervisor_state (instance_id, hostname, pid, started_at, heartbeat_at, children_json)
         VALUES ($1, $2, $3, NOW(), NOW(), $4)
         ON CONFLICT (instance_id) DO UPDATE SET heartbeat_at = NOW(), children_json = $4, hostname = $2, pid = $3`,
        instanceId, hostname(), process.pid, JSON.stringify(children),
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO cw_system_settings (key, value, updated_at) VALUES ('worker.liveness.supervisor', ${ISO_NOW} || '|' || $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = ${ISO_NOW} || '|' || $1, updated_at = NOW()`,
        `${hostname()}|${process.pid}`,
      );
    },

    async clearLiveness(): Promise<void> {
      await prisma.$executeRawUnsafe(`DELETE FROM cw_supervisor_state WHERE instance_id = $1`, instanceId);
    },

    async runningJobs(profileName: string) {
      const escaped = profileName.replace(/[\%_]/g, (c) => `\${c}`);
      const rows = await prisma.$queryRawUnsafe<{ id: string; type: string; attempts: number }[]>(
        `SELECT id, type, attempts FROM cw_jobs WHERE status = 'RUNNING' AND locked_by LIKE $1 LIMIT 20`,
        `${escaped}-%@%`,
      );
      return rows;
    },

    async audit(eventType: string, resourceId: string, detail: Record<string, unknown>, success: boolean): Promise<void> {
      await prisma.auditEvent.create({
        data: { eventType, resourceType: "worker", resourceId: resourceId.slice(0, 255), detailJson: JSON.stringify({ ...detail, actor: "system:supervisor" }), success },
      });
    },
  };
}
