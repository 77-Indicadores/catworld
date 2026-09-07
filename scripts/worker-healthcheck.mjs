#!/usr/bin/env node
/**
 * HEALTHCHECK do Docker para os serviços worker-uploads/worker-sync (Camada 2
 * da proposta de auditoria — ver src/worker/metrics.ts:writeWorkerLiveness).
 *
 * Lê a pulsação geral que o worker grava em cw_system_settings a cada ~15s
 * (independente de qualquer job específico — roda mesmo se o worker estiver
 * ocioso). Se estiver velha demais, o processo travou de verdade (não só um
 * job individual) e o Docker/Coolify reinicia o container sozinho.
 *
 * Sai com 0 (saudável) ou 1 (não saudável) — nunca lança, sempre sai limpo.
 */
import pg from "pg";

const STALE_AFTER_MS = 90_000; // 6x o intervalo de escrita (15s) — folga pra hiccups transientes
const CONNECT_TIMEOUT_MS = 5_000;

async function main() {
  const workerId = process.env.CATWORLD_WORKER_ID;
  const databaseUrl = process.env.CATWORLD_DATABASE_URL;
  if (!workerId || !databaseUrl) {
    console.error("[healthcheck] CATWORLD_WORKER_ID ou CATWORLD_DATABASE_URL ausente");
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  try {
    await client.connect();
    const result = await client.query(
      `SELECT value FROM cw_system_settings WHERE key = $1`,
      [`worker.liveness.${workerId}`],
    );
    const raw = result.rows[0]?.value;
    if (!raw) {
      // Worker recem-iniciado — ainda nao gravou a primeira pulsacao. Nao falha
      // o healthcheck aqui; o Docker so chama isso apos o start_period.
      console.log("[healthcheck] sem pulsacao ainda (worker recem-iniciado?)");
      process.exit(0);
    }
    const ageMs = Date.now() - new Date(raw).getTime();
    if (ageMs > STALE_AFTER_MS) {
      console.error(`[healthcheck] pulsacao velha: ${Math.round(ageMs / 1000)}s (limite ${STALE_AFTER_MS / 1000}s)`);
      process.exit(1);
    }
    console.log(`[healthcheck] ok, pulsacao ha ${Math.round(ageMs / 1000)}s`);
    process.exit(0);
  } catch (e) {
    console.error("[healthcheck] erro:", e instanceof Error ? e.message : e);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
