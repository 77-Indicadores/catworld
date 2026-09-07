/**
 * Camada 1 (auditoria) — observabilidade do worker sem mudar nenhuma decisão de
 * agendamento/concorrência já existente (max_heavy_jobs, max_syncs_per_storage
 * etc. continuam exatamente como estão, configuráveis em /settings/worker).
 *
 * Dois mecanismos:
 *  - startHeartbeat: mesmo heartbeat de sempre (heartbeatAt a cada 15s), agora
 *    também grava o RSS atual do processo. Se o worker morrer no meio de um
 *    job, essa é a última leitura de memória antes de travar/crashar — hoje
 *    a única pista era "heartbeat parou", sem saber o estado de memória.
 *  - recordJobMetric: histórico por job (memória antes/depois, duração,
 *    tamanho de arquivo) em cw_job_metrics — tabela própria que sobrevive à
 *    limpeza de cw_jobs feita pelo METADATA_CLEANUP.
 */
import { prisma } from "@/server/db";

/** RSS do processo atual, em MB inteiros. */
export function currentRssMb(): number {
  return Math.round(process.memoryUsage().rss / (1024 * 1024));
}

/**
 * Substitui os setInterval(heartbeatAt) duplicados em worker/index.ts.
 * Retorna o handle — chamador é responsável por clearInterval no finally.
 */
export function startHeartbeat(jobId: string): ReturnType<typeof setInterval> {
  return setInterval(
    () => prisma.job.update({
      where: { id: jobId },
      data: { heartbeatAt: new Date(), heartbeatRssMb: currentRssMb() },
    }).catch(
      (e) => console.warn("[heartbeat] falhou job=%s: %s", jobId, e instanceof Error ? e.message : e),
    ),
    15000,
  );
}

export type JobMetricInput = {
  jobId: string;
  jobType: string;
  status: "COMPLETED" | "FAILED";
  weight: number;
  fileSizeBytes?: bigint | null;
  rssBeforeMb: number;
  rssAfterMb: number;
  durationMs: number;
  errorMessage?: string | null;
  workerLabel: string;
};

/**
 * Camada 2 — pulsação geral do worker (independente de qualquer job específico),
 * gravada em cw_system_settings. Consumida por scripts/worker-healthcheck.mjs
 * (HEALTHCHECK do Docker) pra reiniciar o container sozinho se o processo travar.
 *
 * Diferente do heartbeat por job (que só bate enquanto aquele job roda), esta
 * função é chamada do loop de recovery, que roda o tempo todo — inclusive
 * quando o worker está ocioso ou algum job individual está travado. Se o
 * processo inteiro travar de verdade (não só um job), essa pulsação também para.
 */
export async function writeWorkerLiveness(workerId: string): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO cw_system_settings (key, value, updated_at)
       VALUES ($1, NOW()::text, NOW())
       ON CONFLICT (key) DO UPDATE SET value = NOW()::text, updated_at = NOW()`,
      `worker.liveness.${workerId}`,
    );
  } catch (e) {
    console.warn("[liveness] falhou: %s", e instanceof Error ? e.message : e);
  }
}

/** Nunca lança — auditoria não pode derrubar o processamento do job. */
export async function recordJobMetric(m: JobMetricInput): Promise<void> {
  try {
    await prisma.jobMetric.create({
      data: {
        jobId: m.jobId,
        jobType: m.jobType,
        status: m.status,
        weight: m.weight,
        fileSizeBytes: m.fileSizeBytes ?? null,
        rssBeforeMb: m.rssBeforeMb,
        rssAfterMb: m.rssAfterMb,
        durationMs: m.durationMs,
        errorMessage: m.errorMessage ?? null,
        workerLabel: m.workerLabel,
      },
    });
  } catch (e) {
    console.warn("[metrics] falhou ao gravar job=%s: %s", m.jobId, e instanceof Error ? e.message : e);
  }
}
