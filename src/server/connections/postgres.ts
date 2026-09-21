import { Client, type ClientConfig, type QueryConfig, type QueryResult } from "pg";
import { decryptSecret } from "@/server/security/crypto";
import { validateReadOnlySql } from "@/server/security/sql-safety";
import { ApiError } from "@/server/http";
import { sqlIdentifier } from "@/server/security/naming";
import { resolveEffectiveTarget, type SshTunnelConnection } from "./ssh-tunnel";
import { SOURCE_SESSION_SETTINGS, sourceTypes } from "./source-pg-types";
import { TEXT_TYPE, decimalOrText, numericFromTypmod } from "./source-values";

export type PgConnection = SshTunnelConnection & {
  server: string;
  port: number | null;
  databaseName: string;
  username: string;
  encryptedCredentials: string;
  sslMode: string;
};

export type SourceColumn = {
  originalName: string;
  sqlName: string;
  sqlType: string;
  nullable: boolean;
  pgType?: string;
  /** numerico que nao cabe em DECIMAL(p,s) exato (float, numeric sem escala): vira texto; ver source-values.compareWithCatalog */
  lossyNumeric?: boolean;
  /** coluna legada preservada como DECIMAL: escala excedente arredonda (como sempre foi); NaN/estouro falham */
  legacyRound?: boolean;
};

function config(connection: PgConnection, target: { host: string; port: number }): ClientConfig {
  const { password } = JSON.parse(decryptSecret(connection.encryptedCredentials)) as { password: string };
  const sslMode = connection.sslMode || "require";
  return {
    host: target.host,
    port: target.port,
    database: connection.databaseName,
    user: connection.username,
    password,
    ssl: sslMode === "disable" ? false : { rejectUnauthorized: sslMode === "verify-full" },
    connectionTimeoutMillis: 10000,
    statement_timeout: 120000,
  };
}

export async function withPg<T>(connection: PgConnection, fn: (client: Client) => Promise<T>) {
  const tunnel = await resolveEffectiveTarget(connection, 5432);
  try {
    const client = new Client(config(connection, tunnel));
    await client.connect();
    // Toda leitura de fonte externa e somente leitura, mesmo que a conta da fonte tenha permissao de escrita.
    await client.query("SET default_transaction_read_only = on");
    try {
      return await fn(client);
    } finally {
      await client.end().catch(() => undefined);
    }
  } finally {
    await tunnel.close().catch(() => undefined);
  }
}

export async function testPostgres(connection: PgConnection) {
  const started = Date.now();
  const result = await withPg(connection, (client) => client.query("SELECT current_database() AS database_name"));
  return { latencyMs: Date.now() - started, database: result.rows[0]?.database_name as string | undefined };
}

export async function listSchemas(connection: PgConnection) {
  return withPg(connection, async (client) => {
    const result = await client.query<{ schema: string }>(
      `SELECT schema_name AS schema
       FROM information_schema.schemata
       WHERE schema_name NOT IN ('pg_catalog','information_schema')
         AND schema_name NOT LIKE 'pg_toast%'
       ORDER BY schema_name`,
    );
    return result.rows;
  });
}

export async function listTables(connection: PgConnection, schema?: string) {
  return withPg(connection, async (client) => {
    const result = await client.query<{ schema: string; table: string }>(
      `SELECT table_schema AS schema, table_name AS table
       FROM information_schema.tables
       WHERE table_type IN ('BASE TABLE','VIEW')
         AND table_schema NOT IN ('pg_catalog','information_schema')
         AND ($1::text IS NULL OR table_schema=$1)
       ORDER BY table_schema, table_name`,
      [schema ?? null],
    );
    return result.rows;
  });
}

export async function tableColumns(connection: PgConnection, schema: string, table: string): Promise<SourceColumn[]> {
  return withPg(connection, async (client) => {
    const result = await client.query<{
      column_name: string;
      data_type: string;
      udt_name: string;
      is_nullable: string;
      numeric_precision: number | null;
      numeric_scale: number | null;
    }>(
      `SELECT column_name,data_type,udt_name,is_nullable,numeric_precision,numeric_scale
       FROM information_schema.columns
       WHERE table_schema=$1 AND table_name=$2
       ORDER BY ordinal_position`,
      [schema, table],
    );
    return result.rows.map((row) => {
      const m = mapPgType(row);
      return {
        originalName: row.column_name,
        sqlName: sqlIdentifier(row.column_name),
        sqlType: m.sqlType,
        nullable: row.is_nullable !== "NO",
        pgType: row.udt_name || row.data_type,
        ...(m.lossyNumeric ? { lossyNumeric: true } : {}),
      };
    });
  });
}

export async function queryColumns(connection: PgConnection, query: string): Promise<SourceColumn[]> {
  const statement = safeStatement(query);
  return withPg(connection, async (client) => {
    const result = await pgQuery(client, `SELECT * FROM (${statement}) cw_source_probe LIMIT 0`);
    return (result.fields ?? []).map((field) => {
      const m = mapPgOid(field.dataTypeID, field.dataTypeModifier);
      return {
        originalName: field.name,
        sqlName: sqlIdentifier(field.name),
        sqlType: m.sqlType,
        nullable: true,
        pgType: String(field.dataTypeID),
        ...(m.lossyNumeric ? { lossyNumeric: true } : {}),
      };
    });
  });
}

import { legacyFormatColumns, mssqlKind, normalizeRows, pgKind, type ColumnKind } from "@/server/sql-contract/result";
import { dedupeColumnNames, rowsFromArrays } from "@/server/sql-contract/columns";

export async function executePostgresReadOnly(connection: PgConnection, query: string, timeout = 30, limit = 10000, offset = 0, normalize = false, orderBy?: string) {
  const statement = safeStatement(query);
  return withPg(connection, async (client) => {
    await client.query(`SET statement_timeout TO ${Math.min(Math.max(timeout, 1), 120) * 1000}`);
    const started = Date.now();
    const result = await pgQueryArray(client, `SELECT * FROM (${statement}) cw_live_result${orderBy?.trim() ? ` ORDER BY ${orderBy}` : ""} LIMIT ${Math.min(Math.max(limit, 1), 10000) + 1} OFFSET ${Math.max(offset, 0)}`);
    const names = dedupeColumnNames(result.fields.map((f) => f.name));
    const pgKinds = Object.fromEntries(result.fields.map((f, i) => [names[i]!, pgKind(f.dataTypeID)])) as Record<string, ColumnKind>;
    const sliced = rowsFromArrays(result.rows.slice(0, limit) as unknown[][], names);
    const rows = normalize
      ? normalizeRows(sliced, Object.fromEntries(result.fields.map((f, i) => [names[i]!, pgKind(f.dataTypeID)])) as Record<string, ColumnKind>, "pg")
      : sliced;
    return {
      columns: names,
      rows,
      rowCount: rows.length,
      truncated: result.rows.length > limit,
      executionTimeMs: Date.now() - started,
      ...(normalize || legacyFormatColumns(pgKinds, "pg").length === 0 ? {} : { legacyFormatColumns: legacyFormatColumns(pgKinds, "pg") }),
    };
  });
}

export async function* streamPostgresRows(connection: PgConnection, query: string, batchSize = 1000): AsyncGenerator<Record<string, unknown>[]> {
  const statement = safeStatement(query);
  const tunnel = await resolveEffectiveTarget(connection, 5432);
  const client = new Client({ ...config(connection, tunnel), types: sourceTypes });
  // Sem listener, um `error` do socket (rede caiu, servidor reiniciou) num cliente ocioso derruba o processo inteiro
  // (unhandled 'error' event). Guarda o erro; a proxima consulta do cursor rejeita normalmente e o refresh falha com mensagem.
  let clientError: Error | null = null;
  client.on("error", (err) => { clientError = err; console.warn(`[source-stream] erro na conexao da origem: ${err.message}`); });
  try {
    await client.connect();
  } catch (e) {
    await tunnel.close().catch(() => undefined);
    throw e;
  }
  try {
    // Sessao fixa (UTC, interval ISO, bytea hex): o texto cru das datas nao depende de fuso do processo nem do servidor da origem.
    for (const stmt of SOURCE_SESSION_SETTINGS) await pgQuery(client, stmt);
    // Cursor numa transacao unica (snapshot REPEATABLE READ): nada some nem se repete se a origem mudar durante a extracao
    // (LIMIT/OFFSET sem ORDER BY, como era, nao garante isso).
    await pgQuery(client, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await pgQuery(client, `DECLARE cw_extract_cur NO SCROLL CURSOR FOR ${statement}`);
    while (true) {
      const result = await pgQuery(client, `FETCH FORWARD ${Math.max(1, Math.floor(batchSize))} FROM cw_extract_cur`);
      if (!result.rows.length) break;
      yield result.rows as Record<string, unknown>[];
      if (result.rows.length < batchSize) break;
    }
    if (clientError) throw clientError;
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end().catch(() => undefined);
    await tunnel.close().catch(() => undefined);
  }
}

export function safeStatement(query: string) {
  const validated = validateReadOnlySql(query);
  if (!validated.safe) throw new ApiError(400, "UNSAFE_SQL", validated.reason);
  return validated.statement;
}

export function quotedPgTable(schema: string, table: string) {
  return `"${schema.replaceAll('"', '""')}"."${table.replaceAll('"', '""')}"`;
}

async function pgQuery<T extends Record<string, unknown> = Record<string, unknown>>(client: Client, query: string | QueryConfig): Promise<QueryResult<T>> {
  try {
    return await client.query<T>(query);
  } catch (error) {
    throw postgresError(error);
  }
}

/** Igual a pgQuery, mas em rowMode "array" (colunas de mesmo nome nao se sobrescrevem — ver columns.ts). */
async function pgQueryArray(client: Client, text: string) {
  try {
    return await client.query({ text, rowMode: "array" });
  } catch (error) {
    throw postgresError(error);
  }
}

function postgresError(error: unknown) {
  if (error instanceof ApiError) return error;
  if (error instanceof Error && "code" in error) {
    const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "POSTGRES_ERROR";
    return new ApiError(400, "POSTGRES_QUERY_FAILED", error.message, { postgresCode: code });
  }
  return error;
}

type Mapped = { sqlType: string; lossyNumeric?: boolean };

function mapPgType(row: { data_type: string; udt_name: string; numeric_precision: number | null; numeric_scale: number | null }): Mapped {
  const type = (row.udt_name || row.data_type).toLowerCase();
  if (["int2", "int4", "int8", "smallint", "integer", "bigint"].includes(type)) return { sqlType: "BIGINT" };
  if (["numeric", "decimal"].includes(type)) return decimalOrText(row.numeric_precision, row.numeric_scale);
  if (["float4", "float8", "real", "double precision"].includes(type)) return { sqlType: TEXT_TYPE, lossyNumeric: true };
  if (["date"].includes(type)) return { sqlType: "DATE" };
  if (["timestamp", "timestamptz", "timestamp without time zone", "timestamp with time zone"].includes(type)) return { sqlType: "DATETIME2" };
  // timetz guarda o deslocamento; TIME do storage nao: texto preserva o valor.
  if (["time", "time without time zone"].includes(type)) return { sqlType: "TIME" };
  return { sqlType: TEXT_TYPE };
}

function mapPgOid(oid: number, typmod?: number): Mapped {
  if ([20, 21, 23].includes(oid)) return { sqlType: "BIGINT" };
  if (oid === 1700) { const n = numericFromTypmod(typmod); return decimalOrText(n.precision, n.scale); }
  if ([700, 701].includes(oid)) return { sqlType: TEXT_TYPE, lossyNumeric: true };
  if (oid === 1082) return { sqlType: "DATE" };
  if ([1114, 1184].includes(oid)) return { sqlType: "DATETIME2" };
  if (oid === 1083) return { sqlType: "TIME" };
  return { sqlType: TEXT_TYPE };
}

/** Relogio da origem (UTC), para limitar a marca d'agua de fontes incrementais. */
export async function sourceClockPg(connection: PgConnection): Promise<Date> {
  return withPg(connection, async (client) => {
    const r = await client.query<{ now: string }>("SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS now");
    return new Date(r.rows[0]!.now);
  });
}
