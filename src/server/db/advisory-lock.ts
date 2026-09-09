import { prisma } from "@/server/db";

/**
 * Convert the first 15 hex chars of a UUID (no dashes) into a positive bigint
 * suitable for pg_advisory_lock/pg_advisory_xact_lock.
 */
export function advisoryLockKey(id: string): bigint {
  return BigInt("0x" + id.replace(/-/g, "").slice(0, 15));
}

/**
 * Runs `fn` while holding a Postgres session-level advisory lock keyed by `id`.
 * Serializes concurrent workers that would otherwise race on the same logical
 * resource (e.g. metadata updates for the same dataset table).
 */
export async function withAdvisoryLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const lockKey = advisoryLockKey(id);
  await prisma.$executeRawUnsafe(`SELECT pg_advisory_lock(${lockKey})`);
  try {
    return await fn();
  } finally {
    await prisma.$executeRawUnsafe(`SELECT pg_advisory_unlock(${lockKey})`).catch(() => {});
  }
}
