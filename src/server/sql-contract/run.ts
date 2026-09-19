/**
 * Ponto de entrada unico para executar T-SQL do usuario contra o STORAGE de um
 * dataset, qualquer que seja o provider (MSSQL ou Postgres). Roteamento, isolamento por ator e
 * contrato de traducao/resultado ficam aqui, nao repetidos em cada rota.
 */
import { executeReadOnly } from "@/server/azure/sql";
import { getDefaultStorageServerId, getStorageConnection, type StorageConnection } from "@/server/storage/connection";
import type { Actor } from "@/server/auth/actor";
import type { ScopeDataset } from "@/server/auth/permissions";
import { getPgIsolationMode, syncPgReaderRole, warnIfSuperuser } from "@/server/storage/pg-roles";
import type { PgStorageConnection } from "@/server/storage/pg-storage";

export type QueryResult = Awaited<ReturnType<typeof executeReadOnly>>;

let isolationOffWarned = false;

/**
 * Papel de banco (Postgres) com que a consulta do ator deve rodar; `null` = sem SET ROLE (admin, ou
 * isolamento desligado por configuracao, ou storage que nao e Postgres). Garante que o papel exista e
 * tenha acesso exatamente aos schemas dos datasets acessiveis NESTE storage.
 */
export async function pgRoleForActor(
  conn: StorageConnection,
  actor: Actor,
  accessible: ScopeDataset[],
  storageServerId: string | null,
): Promise<string | null> {
  if (conn.provider !== "postgres") return null;
  const pg = conn as unknown as PgStorageConnection;
  await warnIfSuperuser(pg._pool).catch(() => undefined);
  if (actor.type === "user" && actor.role === "ADMIN") return null;
  if ((await getPgIsolationMode()) === "off") {
    if (!isolationOffWarned) {
      isolationOffWarned = true;
      console.warn("[pg-isolation] DESLIGADO (pg_isolation.mode = off): consultas de nao-admin no Postgres NAO sao isoladas por schema.");
    }
    return null;
  }
  const serverId = storageServerId ?? (await getDefaultStorageServerId());
  const defaultId = await getDefaultStorageServerId();
  const schemas = accessible
    .filter((d) => (d.storageServerId ?? defaultId) === serverId)
    .map((d) => d.schemaName);
  await syncPgReaderRole(serverId, pg._pool, actor.principal, schemas);
  return actor.principal;
}

export async function runStorageQuery(opts: {
  actor: Actor;
  /** Datasets que o ator pode ler (de resolveQueryScope) — define o que o papel de banco enxerga. */
  accessible: ScopeDataset[];
  sql: string;
  timeout: number;
  limit: number;
  offset?: number;
  schemas: string[];
  storageServerId: string | null;
  normalize?: boolean;
}): Promise<QueryResult> {
  const conn = await getStorageConnection(opts.storageServerId);
  if (conn.provider === "postgres") {
    const { executeReadOnlyPg } = await import("@/server/storage/pg-query");
    const role = await pgRoleForActor(conn, opts.actor, opts.accessible, opts.storageServerId);
    return executeReadOnlyPg(
      conn as unknown as PgStorageConnection,
      opts.sql,
      opts.timeout,
      opts.limit,
      opts.schemas,
      opts.offset ?? 0,
      opts.normalize ?? false,
      role,
    );
  }
  return executeReadOnly(opts.actor.principal, opts.sql, opts.timeout, opts.limit, opts.schemas, opts.offset ?? 0, 120, opts.storageServerId, opts.normalize ?? false);
}
