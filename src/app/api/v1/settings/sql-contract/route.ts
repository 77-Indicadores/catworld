/**
 * GET   /api/v1/settings/sql-contract — modo atual do contrato de SQL
 * PATCH /api/v1/settings/sql-contract — { mode?: "off"|"shadow"|"fallback"|"strict", pgIsolation?: "enforce"|"off" }
 *
 * off = comportamento anterior; shadow = igual ao anterior + log do que o motor novo faria
 * diferente; fallback (padrao) = motor novo com rede de seguranca do antigo; strict = so o novo.
 * Ver docs/sql-contract.md.
 *
 * pgIsolation (storage Postgres): enforce (padrao) = cada ator nao-admin roda em papel de banco com acesso so aos
 * seus schemas; off = valvula de escape (loga aviso) para storage sem CREATEROLE. Ver storage/pg-roles.ts.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/server/db";
import { resolveActor, requireRole } from "@/server/auth/actor";
import { handleApiError, ok } from "@/server/http";
import { audit } from "@/server/audit";
import { getContractMode, getContractStats, invalidateContractModeCache } from "@/server/sql-contract/apply";
import { getPgIsolationMode, invalidatePgIsolationModeCache } from "@/server/storage/pg-roles";

export async function GET(r: NextRequest) {
  try {
    requireRole(await resolveActor(r), ["ADMIN"]);
    return ok({ mode: await getContractMode(), modes: ["off", "shadow", "fallback", "strict"], pgIsolation: await getPgIsolationMode(), stats: getContractStats() });
  } catch (e) {
    return handleApiError(e);
  }
}

export async function PATCH(r: NextRequest) {
  try {
    const actor = await resolveActor(r);
    requireRole(actor, ["ADMIN"]);
    const input = z.object({
      mode: z.enum(["off", "shadow", "fallback", "strict"]).optional(),
      pgIsolation: z.enum(["enforce", "off"]).optional(),
    }).refine((v) => v.mode !== undefined || v.pgIsolation !== undefined, { message: "Informe mode e/ou pgIsolation" }).parse(await r.json());
    const put = (key: string, value: string) => prisma.$executeRawUnsafe(
      `INSERT INTO cw_system_settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      key, value,
    );
    if (input.mode) { await put("sql_contract.mode", input.mode); invalidateContractModeCache(); }
    if (input.pgIsolation) { await put("pg_isolation.mode", input.pgIsolation); invalidatePgIsolationModeCache(); }
    await audit(actor, "SQL_CONTRACT_MODE_CHANGED", "settings", undefined, input);
    return ok({ mode: await getContractMode(), pgIsolation: await getPgIsolationMode() });
  } catch (e) {
    return handleApiError(e);
  }
}
