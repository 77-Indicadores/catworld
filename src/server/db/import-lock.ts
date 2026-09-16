import { hostname } from "node:os";
import { prisma } from "@/server/db";

// Substitui, só pro pipeline de import (src/server/uploads/importer.ts), o
// mecanismo antigo de segurar uma transação Postgres aberta durante todo o
// tempo do trabalho externo no SQL Server (withAdvisoryLockForString em
// advisory-lock.ts). Aquele desenho funciona bem quando o trabalho protegido
// é rápido, mas o import de uma tabela grande pode legitimamente demorar
// minutos por causa de lock de leitura concorrente na tabela física (DROP
// TABLE do swap exige lock exclusivo) — e isso não tem nada a ver com o
// Postgres, então não devia poder estourar um timeout de transação Postgres.
//
// Aqui o lock é uma linha (upsert condicional em expires_at), adquirida e
// liberada com queries pontuais — nunca com uma transação de vida longa. Se
// o processo morrer no meio (crash, restart do worker) sem liberar, o lock
// expira sozinho depois de `ttlMs` e a próxima tentativa pode retomá-lo.

const DEFAULT_TTL_MS = 30 * 60_000; // mesmo teto usado em advisory-lock.ts
const POLL_MS = 2_000;

function holderId(): string {
  return `${hostname()}:${process.pid}:${Date.now()}`;
}

async function tryAcquire(key: string, holder: string, ttlMs: number): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ lock_key: string }[]>`
    INSERT INTO cw_import_locks (lock_key, locked_at, locked_by, expires_at)
    VALUES (${key}, now(), ${holder}, now() + (${ttlMs}::text || ' milliseconds')::interval)
    ON CONFLICT (lock_key) DO UPDATE
      SET locked_at = EXCLUDED.locked_at, locked_by = EXCLUDED.locked_by, expires_at = EXCLUDED.expires_at
      WHERE cw_import_locks.expires_at < now()
    RETURNING lock_key
  `;
  return rows.length > 0;
}

async function release(key: string, holder: string): Promise<void> {
  // Só apaga se o holder ainda bater — evita que um release atrasado (ex: timeout
  // de rede no fim do fn) apague um lock que já foi legitimamente retomado por
  // outro processo depois de expirar.
  await prisma.$executeRaw`DELETE FROM cw_import_locks WHERE lock_key = ${key} AND locked_by = ${holder}`;
}

/**
 * Serializa `fn` por `key` usando um lock por linha (sem transação Postgres de
 * vida longa) — `fn` pode demorar o quanto precisar (é trabalho externo, ex:
 * SQL Server) sem risco de estourar timeout de transação do Postgres.
 *
 * Espera até `maxWaitMs` (padrão 30min, mesmo teto do lock antigo) por um lock
 * já detido por outra execução; se não conseguir a tempo, lança erro — o
 * chamador (job de import) já tem retry próprio.
 */
export async function withImportLock<T>(key: string, fn: () => Promise<T>, maxWaitMs = DEFAULT_TTL_MS): Promise<T> {
  const holder = holderId();
  const deadline = Date.now() + maxWaitMs;

  while (!(await tryAcquire(key, holder, DEFAULT_TTL_MS))) {
    if (Date.now() >= deadline) {
      throw new Error(`Não foi possível obter o lock de import para "${key}" — outro import está em andamento nela.`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  try {
    return await fn();
  } finally {
    await release(key, holder);
  }
}
