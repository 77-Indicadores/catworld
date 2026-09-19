/**
 * Isolamento por ator no storage POSTGRES — o equivalente dos principais do SQL Server (azure/sql.ts).
 *
 * Antes, o Postgres usava uma conta unica da aplicacao: qualquer ator autenticado lia QUALQUER schema
 * do servidor (bastava qualificar o nome). Agora cada ator nao-admin tem um papel NOLOGIN
 * (`cw_u_…` / `cw_t_…`) com USAGE + SELECT so nos schemas dos datasets a que tem acesso, e cada
 * consulta roda em `BEGIN READ ONLY` + `SET LOCAL ROLE`. Funcoes perigosas (pg_read_file, lo_import…)
 * ficam negadas porque o papel nao e superusuario, mesmo que a conta da aplicacao seja.
 *
 * Requisito: a conta do storage precisa de CREATEROLE (ou ser superusuario). Sem isso, o modo
 * `enforce` falha FECHADO (503). Valvula de escape: cw_system_settings `pg_isolation.mode` = 'off'.
 */
import type { Pool } from "pg";
import { prisma } from "@/server/db";
import { ApiError } from "@/server/http";
import { TtlCache } from "@/server/cache/ttl-cache";
import { pgQuote } from "./pg-storage";

export type PgIsolationMode = "enforce" | "off";

const modeCache = new TtlCache<string, PgIsolationMode>(30_000, 1);

export async function getPgIsolationMode(): Promise<PgIsolationMode> {
  const hit = modeCache.get("mode");
  if (hit) return hit;
  let mode: PgIsolationMode = "enforce";
  try {
    const rows = await prisma.$queryRawUnsafe<{ value: string }[]>(
      `SELECT value FROM cw_system_settings WHERE key = 'pg_isolation.mode' LIMIT 1`,
    );
    if (rows[0]?.value === "off") mode = "off";
  } catch {
    // sem tabela/erro de leitura: mantem o padrao seguro
  }
  modeCache.set("mode", mode);
  return mode;
}

export function invalidatePgIsolationModeCache() {
  modeCache.deleteWhere(() => true);
}

const ROLE_NAME = /^[a-z0-9_]{1,63}$/i;
const SYNC_TTL_MS = 60_000;
const synced = new Map<string, number>();
const inFlight = new Map<string, Promise<void>>();

/** Nome do papel do ator (mesma regra do principal do SQL Server). */
export function roleFor(principal: string): string {
  if (!ROLE_NAME.test(principal)) throw new ApiError(500, "INVALID_PRINCIPAL", "Principal invalido para papel de banco");
  return principal;
}

/**
 * Garante que o papel existe e tem acesso EXATAMENTE aos `schemas` (revoga os demais).
 * Cache de 60 s por (servidor, ator, conjunto): revogacao vale em ate 60 s.
 */
export async function syncPgReaderRole(serverKey: string, pool: Pool, principal: string, schemas: string[]): Promise<void> {
  const role = roleFor(principal);
  const desired = [...new Set(schemas)].sort();
  const key = `${serverKey}|${role}|${desired.join(",")}`;
  const at = synced.get(key);
  if (at && Date.now() - at < SYNC_TTL_MS) return;
  const running = inFlight.get(key);
  if (running) return running;

  const p = doSync(pool, role, desired)
    .then(() => { synced.set(key, Date.now()); })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

export function invalidatePgRoleCache() {
  synced.clear();
}

async function doSync(pool: Pool, role: string, schemas: string[]): Promise<void> {
  const r = pgQuote(role);
  const client = await pool.connect();
  try {
    try {
      const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
      if (!exists.rowCount) {
        try {
          await client.query(`CREATE ROLE ${r} NOLOGIN NOINHERIT`);
        } catch (e) {
          if ((e as { code?: string }).code !== "42710") throw e; // outro processo criou ao mesmo tempo
        }
      }
      // A conta da aplicacao precisa poder SET ROLE nele (superusuario ja pode).
      await client.query(`GRANT ${r} TO CURRENT_USER`).catch(() => undefined);

      // Revoga o que sobrou de schemas que o ator nao tem mais
      const current = await client.query<{ nspname: string }>(
        `SELECT nspname FROM pg_namespace
          WHERE nspname NOT LIKE 'pg\\_%' AND nspname NOT IN ('information_schema', 'public')
            AND has_schema_privilege($1, oid, 'USAGE')`,
        [role],
      );
      for (const { nspname } of current.rows) {
        if (schemas.includes(nspname)) continue;
        await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${pgQuote(nspname)} FROM ${r}`);
        await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${pgQuote(nspname)} REVOKE SELECT ON TABLES FROM ${r}`);
        await client.query(`REVOKE ALL ON SCHEMA ${pgQuote(nspname)} FROM ${r}`);
      }
      for (const s of schemas) {
        const q = pgQuote(s);
        const has = await client.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [s]);
        if (!has.rowCount) continue; // dataset sem schema ainda
        await client.query(`GRANT USAGE ON SCHEMA ${q} TO ${r}`);
        await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${q} TO ${r}`);
        // tabelas criadas depois (troca atomica de staging) ja nascem legiveis
        await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${q} GRANT SELECT ON TABLES TO ${r}`);
      }
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "42501") {
        throw new ApiError(
          503,
          "STORAGE_ROLE_SETUP_FAILED",
          "O storage Postgres nao permite criar papeis de acesso (falta CREATEROLE na conta da aplicacao). Avise o administrador.",
        );
      }
      throw e;
    }
  } finally {
    client.release();
  }
}

let superuserWarned = false;
/** Avisa (uma vez) se a conta do storage e superusuario: o isolamento vale, mas a conta e privilegiada demais. */
export async function warnIfSuperuser(pool: Pool): Promise<boolean> {
  const r = await pool.query<{ rolsuper: boolean; rolname: string }>("SELECT rolsuper, rolname FROM pg_roles WHERE rolname = current_user");
  const su = Boolean(r.rows[0]?.rolsuper);
  if (su && !superuserWarned) {
    superuserWarned = true;
    console.warn(`[pg-storage] a conta '${r.rows[0]!.rolname}' do storage e SUPERUSUARIO. O isolamento por papel protege as consultas, mas use uma conta sem superuser (com CREATEROLE).`);
  }
  return su;
}
