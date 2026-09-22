import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { resolveActor } from "@/server/auth/actor";
import { summarizeIntegrity } from "@/server/integrity/ledger";

/**
 * GET /api/health/integrity — estado de INTEGRIDADE DOS DADOS para o monitor (docs/estudo-confiabilidade-dados.md, seção 8).
 * Disponibilidade ("o banco responde") não diz se a tabela está completa: este endpoint diz se alguma carga foi barrada ou está
 * suspeita, se jobs estão sendo recolocados/derrubados e se há fila parada. Sem login: só `degraded` (para monitores externos);
 * o detalhe (tabelas, contagens) só para quem está autenticado.
 */
export async function GET(request: NextRequest) {
  const authenticated = await resolveActor(request, { audit: false }).then(() => true, () => false);
  const time = new Date().toISOString();
  try {
    const [summary, crashes, oldestQueued] = await Promise.all([
      summarizeIntegrity(24),
      prisma.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*) AS n FROM cw_audit_events WHERE event_type = 'WORKER_CRASHED' AND created_at > now() - interval '1 hour'`,
      prisma.$queryRaw<{ minutes: number | null }[]>`SELECT EXTRACT(EPOCH FROM (now() - MIN(available_at))) / 60 AS minutes FROM cw_jobs WHERE status = 'QUEUED' AND available_at <= now()`,
    ]);
    const crashes1h = Number(crashes[0]?.n ?? 0);
    const oldestQueuedMin = oldestQueued[0]?.minutes === null || oldestQueued[0]?.minutes === undefined ? 0 : Math.round(Number(oldestQueued[0].minutes));
    // limiares: tabela com veredito pendente, 3+ quedas de worker na última hora, ou job na fila há mais de 30 min
    const degraded = summary.tablesNeedingAttention.length > 0 || crashes1h >= 3 || oldestQueuedMin > 30;
    if (!authenticated) return NextResponse.json({ degraded, time });
    return NextResponse.json({ degraded, time, integrity: summary, workerCrashes1h: crashes1h, oldestQueuedJobMinutes: oldestQueuedMin });
  } catch (err) {
    console.error("[health/integrity] %s", err instanceof Error ? err.message : String(err));
    // não conseguir avaliar já é um estado a alertar (nunca "tudo bem" por engano)
    return NextResponse.json({ degraded: true, error: "INTEGRITY_UNAVAILABLE", time }, { status: 503 });
  }
}
