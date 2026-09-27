import { prisma } from "@/server/db";

export type HealthCheckRow = {
  id: string;
  kind: HealthCheckKind;
  outcome: HealthCheckOutcome;
  latencyMs: number | null;
  errorMessage: string | null;
  createdAt: string;
};

export type ConnectionHealthSource = {
  id: string;
  name: string;
  /** EMA (ver DatasetSource.avgRunMs) — suaviza ao longo do tempo, diferente da média abaixo. */
  avgRunMs: number | null;
  /** Média simples de duração das últimas execuções (cw_job_metrics), sem suavização. */
  avgDurationMsFromMetrics: number | null;
  lastRun: { status: string; createdAt: string; durationMs: number | null } | null;
};

export type ConnectionHealth = {
  checks: HealthCheckRow[];
  sources: ConnectionHealthSource[];
  rollup: {
    /** Média das médias por fonte (uma fonte ruidosa não domina o número) — não é a média simples de todas as execuções. */
    avgSourceDurationMs: number | null;
    lastCheckedAt: string | null;
    lastStatus: string | null;
  };
};

const CHECKS_LIMIT = 50;

/** Retenção decidida com o usuário (2026-09-27): 90 dias, limpo pela mesma rotina que já poda cw_jobs (METADATA_CLEANUP). */
export const HEALTH_CHECKS_RETENTION_DAYS = 90;

/**
 * Histórico de saúde de uma conexão (ou storage server): últimos checks (poll/teste) de cw_health_checks
 * + duração média por fonte a partir de cw_job_metrics. Espelha buildTableHistory/loadTableHistory
 * (src/server/tables/history.ts) — mesma separação entre builder puro e I/O.
 */
export async function loadConnectionHealth(connectionId: string): Promise<ConnectionHealth> {
  const [checks, sources] = await Promise.all([
    prisma.healthCheck.findMany({ where: { connectionId }, orderBy: { createdAt: "desc" }, take: CHECKS_LIMIT }),
    prisma.datasetSource.findMany({ where: { connectionId }, select: { id: true, name: true, avgRunMs: true } }),
  ]);
  return buildConnectionHealth(checks, sources, await loadSourceMetricStats(sources.map((s) => s.id)));
}

export async function loadStorageServerHealth(storageServerId: string): Promise<Pick<ConnectionHealth, "checks" | "rollup">> {
  const checks = await prisma.healthCheck.findMany({ where: { storageServerId }, orderBy: { createdAt: "desc" }, take: CHECKS_LIMIT });
  const rows = checks.map(toHealthCheckRow);
  return { checks: rows, rollup: rollupFromChecks(rows) };
}

type SourceMetricStats = Map<string, { avgDurationMs: number | null; lastRun: ConnectionHealthSource["lastRun"] }>;

async function loadSourceMetricStats(sourceIds: string[]): Promise<SourceMetricStats> {
  const stats: SourceMetricStats = new Map();
  if (sourceIds.length === 0) return stats;
  const sources = await prisma.datasetSource.findMany({ where: { id: { in: sourceIds } }, select: { id: true, targetTableId: true } });
  const tableIds = sources.map((s) => s.targetTableId).filter((x): x is string => !!x);
  if (tableIds.length === 0) return stats;
  const [aggregates, lastRuns] = await Promise.all([
    prisma.jobMetric.groupBy({ by: ["tableId"], where: { tableId: { in: tableIds }, status: "COMPLETED" }, _avg: { durationMs: true } }),
    prisma.jobMetric.findMany({ where: { tableId: { in: tableIds } }, orderBy: { createdAt: "desc" }, select: { tableId: true, status: true, durationMs: true, createdAt: true } }),
  ]);
  const avgByTable = new Map(aggregates.map((a) => [a.tableId, a._avg.durationMs ?? null]));
  const lastRunByTable = new Map<string, ConnectionHealthSource["lastRun"]>();
  for (const run of lastRuns) {
    if (!run.tableId || lastRunByTable.has(run.tableId)) continue;
    lastRunByTable.set(run.tableId, { status: run.status, createdAt: run.createdAt.toISOString(), durationMs: run.durationMs });
  }
  for (const s of sources) {
    if (!s.targetTableId) continue;
    stats.set(s.id, { avgDurationMs: avgByTable.get(s.targetTableId) ?? null, lastRun: lastRunByTable.get(s.targetTableId) ?? null });
  }
  return stats;
}

function toHealthCheckRow(c: { id: string; kind: string; outcome: string; latencyMs: number | null; errorMessage: string | null; createdAt: Date }): HealthCheckRow {
  return { id: c.id, kind: c.kind as HealthCheckKind, outcome: c.outcome as HealthCheckOutcome, latencyMs: c.latencyMs, errorMessage: c.errorMessage, createdAt: c.createdAt.toISOString() };
}

function rollupFromChecks(checks: HealthCheckRow[]): ConnectionHealth["rollup"] {
  const last = checks[0];
  return {
    avgSourceDurationMs: null,
    lastCheckedAt: last?.createdAt ?? null,
    lastStatus: last ? (last.outcome === "error" ? "error" : "healthy") : null,
  };
}

export function buildConnectionHealth(
  checksInput: { id: string; kind: string; outcome: string; latencyMs: number | null; errorMessage: string | null; createdAt: Date }[],
  sourcesInput: { id: string; name: string; avgRunMs: number | null }[],
  stats: SourceMetricStats,
): ConnectionHealth {
  const checks = checksInput.map(toHealthCheckRow);
  const sources: ConnectionHealthSource[] = sourcesInput.map((s) => {
    const stat = stats.get(s.id);
    return { id: s.id, name: s.name, avgRunMs: s.avgRunMs, avgDurationMsFromMetrics: stat?.avgDurationMs ?? null, lastRun: stat?.lastRun ?? null };
  });
  const durationSamples = sources.map((s) => s.avgDurationMsFromMetrics).filter((x): x is number => x != null);
  const avgSourceDurationMs = durationSamples.length ? Math.round(durationSamples.reduce((a, b) => a + b, 0) / durationSamples.length) : null;
  const rollup = rollupFromChecks(checks);
  return { checks, sources, rollup: { ...rollup, avgSourceDurationMs } };
}

/** "poll" = check leve (ex.: FTP LIST do watch do Firebird) | "test" = teste manual completo ("Testar conexao"). */
export type HealthCheckKind = "poll" | "test";
export type HealthCheckOutcome = "unchanged" | "changed" | "healthy" | "error";

export type RecordHealthCheckInput =
  | { subjectType: "connection"; connectionId: string; kind: HealthCheckKind; outcome: HealthCheckOutcome; latencyMs?: number | null; errorMessage?: string | null }
  | { subjectType: "storage_server"; storageServerId: string; kind: HealthCheckKind; outcome: HealthCheckOutcome; latencyMs?: number | null; errorMessage?: string | null };

/**
 * Grava uma linha de auditoria em cw_health_checks. Nunca lança — um poll/teste de saúde não pode
 * falhar por causa do próprio registro de auditoria (mesma convenção de recordJobMetric no worker).
 */
export async function recordHealthCheck(input: RecordHealthCheckInput): Promise<void> {
  try {
    await prisma.healthCheck.create({
      data: {
        subjectType: input.subjectType,
        connectionId: input.subjectType === "connection" ? input.connectionId : null,
        storageServerId: input.subjectType === "storage_server" ? input.storageServerId : null,
        kind: input.kind,
        outcome: input.outcome,
        latencyMs: input.latencyMs ?? null,
        errorMessage: input.errorMessage ?? null,
      },
    });
  } catch (e) {
    console.warn("[health-check] falha ao gravar auditoria:", e instanceof Error ? e.message : e);
  }
}
