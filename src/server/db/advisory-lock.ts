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

async function withLockKey<T>(lockKey: bigint, fn: () => Promise<T>): Promise<T> {
  await prisma.$executeRawUnsafe(`SELECT pg_advisory_lock(${lockKey})`);
  try {
    return await fn();
  } finally {
    await prisma.$executeRawUnsafe(`SELECT pg_advisory_unlock(${lockKey})`).catch(() => {});
  }
}

/**
 * Runs `fn` while holding a Postgres session-level advisory lock keyed by a
 * UUID `id`. Serializes concurrent workers that would otherwise race on the
 * same logical resource (e.g. metadata updates for the same dataset table).
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
