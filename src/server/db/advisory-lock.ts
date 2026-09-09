import { createHash } from "node:crypto";
import { prisma } from "@/server/db";

/**
 * Convert the first 15 hex chars of a UUID (no dashes) into a positive bigint
 * suitable for pg_advisory_lock/pg_advisory_xact_lock.
 */
export function advisoryLockKey(id: string): bigint {
  return BigInt("0x" + id.replace(/-/g, "").slice(0, 15));
}

/**
 * Same as advisoryLockKey, but for an arbitrary string (not necessarily a
 * UUID) — hashes it first so any identifier (e.g. "datasetId:schema.table")
 * can be used to derive a lock key.
 */
export function advisoryLockKeyForString(s: string): bigint {
  return advisoryLockKey(createHash("sha1").update(s).digest("hex"));
}

// pg_advisory_lock/pg_advisory_unlock são SESSION-level: só fazem sentido se o
// lock e o unlock rodarem na MESMA conexão física do Postgres. Prisma não dá
// essa garantia entre duas chamadas $executeRawUnsafe separadas — cada uma
// pode pegar uma conexão diferente do pool. Isso já causou "deadlock
// detected" (40P01) em produção: o lock ficava preso pra sempre numa conexão
// (porque o unlock rodou em outra e foi um no-op silencioso), e o próximo
// import que tentasse travar a mesma chave — ou pior, um import numa
// conexão reaproveitada que já tinha um lock alheio pendurado — entrava num
// ciclo de espera cruzada com outro processo na mesma situação.
//
// pg_advisory_xact_lock é TRANSACTION-scoped: liberado automaticamente no
// COMMIT/ROLLBACK (inclusive se o processo cair no meio — a conexão fecha e
// a transação some), sem precisar de unlock explícito. Rodando dentro de
// prisma.$transaction(async tx => ...), a Prisma garante que a chamada do
// lock e o resto do callback (fn) usam a MESMA conexão física, então o lock
// nunca fica "órfão" numa conexão que o pool reaproveitou pra outra coisa.
async function withLockKey<T>(lockKey: bigint, fn: () => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${lockKey})`);
      return fn();
    },
    // maxWait: quanto esperar pra conseguir uma conexão do pool antes de desistir.
    // timeout: quanto tempo a transação (e portanto o lock) pode ficar aberta —
    // precisa ser generoso o bastante pro import inteiro caber aqui dentro.
    { maxWait: 30_000, timeout: 10 * 60_000 },
  );
}

/**
 * Runs `fn` while holding a Postgres transaction-scoped advisory lock keyed
 * by a UUID `id`. Serializes concurrent workers that would otherwise race on
 * the same logical resource (e.g. metadata updates for the same dataset table).
 */
export function withAdvisoryLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  return withLockKey(advisoryLockKey(id), fn);
}

/**
 * Same as withAdvisoryLock, but keyed by an arbitrary string instead of a
 * UUID — e.g. "datasetId:schema.table" to serialize an entire import
 * pipeline (staging DDL, index creation, atomic swap, metadata write) for a
 * given dataset table, not just its final metadata step.
 */
export function withAdvisoryLockForString<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return withLockKey(advisoryLockKeyForString(key), fn);
}
