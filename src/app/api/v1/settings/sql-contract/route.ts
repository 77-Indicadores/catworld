/**
 * GET   /api/v1/settings/sql-contract — modo atual do contrato de SQL
 * PATCH /api/v1/settings/sql-contract — { mode: "off" | "shadow" | "strict" }
 *
 * off = comportamento anterior; shadow (padrao) = igual ao anterior + log do que o motor novo
 * faria diferente; strict = motor novo. Ver docs/sql-contract.md.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { handleApiError, ok } from "@/server/http";
import { audit } from "@/server/audit";
import { getContractMode, invalidateContractModeCache } from "@/server/sql-contract/apply";

export async function GET(r: NextRequest) {
  try {
    requireRole(await resolveActor(r), ["ADMIN"]);
    return ok({ mode: await getContractMode(), modes: ["off", "shadow", "strict"] });
  } catch (e) {
    return handleApiError(e);
  }
}

export async function PATCH(r: NextRequest) {
  try {
    const actor = await resolveActor(r);
    requireRole(actor, ["ADMIN"]);
    const { mode } = z.object({ mode: z.enum(["off", "shadow", "strict"]) }).parse(await r.json());
    await prisma.$executeRawUnsafe(
      `INSERT INTO cw_system_settings (key, value, updated_at) VALUES ('sql_contract.mode', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      mode,
    );
    invalidateContractModeCache();
    await audit(actor, "SQL_CONTRACT_MODE_CHANGED", "settings", undefined, { mode });
    return ok({ mode });
  } catch (e) {
    return handleApiError(e);
  }
}
