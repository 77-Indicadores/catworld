/**
 * GET   /api/v1/settings/integrity — política de integridade das cargas (ADMIN)
 * PATCH /api/v1/settings/integrity — altera `mode` (enforce|warn), `max_drop_pct` (1-99) e `allow_empty`
 *
 * `enforce` (padrão): uma carga que perde linhas contra o esperado, esvazia uma tabela ou cai além do limite NÃO troca a tabela
 * (a anterior continua no ar). `warn`: publica e marca a tabela como "possivelmente incompleta". Ver docs/data-integrity.md.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { audit } from "@/server/audit";
import { handleApiError, ok } from "@/server/http";
import { SETTING_KEYS, getIntegritySettings } from "@/server/integrity/policy";

const patchSchema = z.object({
  mode: z.enum(["enforce", "warn"]).optional(),
  max_drop_pct: z.number().int().min(1).max(99).optional(),
  allow_empty: z.boolean().optional(),
});

const view = async () => {
  const s = await getIntegritySettings();
  return { mode: s.mode, max_drop_pct: s.maxDropPct, allow_empty: s.allowEmpty };
};

export async function GET(r: NextRequest) {
  try {
    requireRole(await resolveActor(r), ["ADMIN"]);
    return ok(await view());
  } catch (e) {
    return handleApiError(e);
  }
}

export async function PATCH(r: NextRequest) {
  try {
    const actor = await resolveActor(r);
    requireRole(actor, ["ADMIN"]);
    const body = patchSchema.parse(await r.json());
    const updates: [string, string][] = [
      ...(body.mode !== undefined ? [[SETTING_KEYS.mode, body.mode] as [string, string]] : []),
      ...(body.max_drop_pct !== undefined ? [[SETTING_KEYS.maxDropPct, String(body.max_drop_pct)] as [string, string]] : []),
      ...(body.allow_empty !== undefined ? [[SETTING_KEYS.allowEmpty, String(body.allow_empty)] as [string, string]] : []),
    ];
    for (const [key, value] of updates) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO cw_system_settings (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        key, value,
      );
    }
    if (updates.length) await audit(actor, "INTEGRITY_SETTINGS_CHANGED", "system_settings", undefined, Object.fromEntries(updates));
    return ok(await view());
  } catch (e) {
    return handleApiError(e);
  }
}
