/**
 * POST /api/v1/settings/worker/preset — aplica um perfil de desempenho (economico | equilibrado | alto). ADMIN.
 *
 * Atômico: as 4 faixas de worker (cria as que faltam) + tetos globais numa transação. NÃO reinicia: a resposta traz
 * `meta.restartProfiles` (perfis cujos slots mudaram); o reinício seguro é um comando à parte (/api/v1/system/commands).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { audit } from "@/server/audit";
import { ApiError, handleApiError, ok } from "@/server/http";
import { PRESET_IDS } from "@/lib/worker-presets";
import { UnknownPresetError, applyPreset } from "@/server/worker/apply-preset";

const bodySchema = z.object({ preset: z.enum(PRESET_IDS as [string, ...string[]]) });

export async function POST(r: NextRequest) {
  try {
    const actor = await resolveActor(r);
    requireRole(actor, ["ADMIN"]);
    const { preset } = bodySchema.parse(await r.json());
    let result;
    try {
      result = await applyPreset(preset);
    } catch (e) {
      if (e instanceof UnknownPresetError) throw new ApiError(400, "VALIDATION_ERROR", e.message);
      throw e;
    }
    await audit(actor, "WORKER_PRESET_APPLIED", "worker_settings", undefined, {
      preset: result.preset,
      changes: result.changes.map(({ key, from, to }) => ({ key, from, to })),
      restartProfiles: result.restartProfiles,
      newProfiles: result.newProfiles,
    });
    return ok(
      { preset: result.preset, changes: result.changes },
      { restartProfiles: result.restartProfiles, newProfiles: result.newProfiles, ...(result.warnings.length ? { warnings: result.warnings } : {}) },
    );
  } catch (e) {
    return handleApiError(e);
  }
}
