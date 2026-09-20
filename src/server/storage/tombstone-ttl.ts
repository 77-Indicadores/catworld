import { prisma } from "@/server/db";
import { TOMBSTONE_TTL_DEFAULT_DAYS } from "./delete-detection";

/** Validade das lapides em dias (`retention.tombstone_days`, padrao 30, 0 = guardar para sempre). Erro/valor invalido = padrao. */
export async function getTombstoneTtlDays(): Promise<number> {
  try {
    const rows = await prisma.$queryRawUnsafe<{ value: string }[]>(
      `SELECT value FROM cw_system_settings WHERE key = 'retention.tombstone_days'`,
    );
    const n = Number(rows?.[0]?.value);
    return Number.isInteger(n) && n >= 0 && n <= 3650 ? n : TOMBSTONE_TTL_DEFAULT_DAYS;
  } catch {
    return TOMBSTONE_TTL_DEFAULT_DAYS;
  }
}
