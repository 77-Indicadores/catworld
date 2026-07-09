import { Client, type ClientConfig } from "pg";
import { decryptSecret } from "@/server/security/crypto";
import { validateReadOnlySql } from "@/server/security/sql-safety";
import { ApiError } from "@/server/http";
import { sqlIdentifier } from "@/server/security/naming";

export type PgConnection = {
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
};

function config(connection: PgConnection): ClientConfig {
  const { password } = JSON.parse(decryptSecret(connection.encryptedCredentials)) as { password: string };
  const sslMode = connection.sslMode || "require";
  return {
    host: connection.server,
    port: connection.port ?? 5432,
    database: connection.databaseName,
    user: connection.username,
    password,
    ssl: sslMode === "disable" ? false : { rejectUnauthorized: sslMode === "verify-full" },
    connectionTimeoutMillis: 10000,
    statement_timeout: 120000,
  };
}

export async function withPg<T>(connection: PgConnection, fn: (client: Client) => Promise<T>) {
  const client = new Client(config(connection));
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
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
       WHERE table_type='BASE TABLE'
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
    return result.rows.map((row) => ({
      originalName: row.column_name,
      sqlName: sqlIdentifier(row.column_name),
      sqlType: mapPgType(row),
      nullable: row.is_nullable !== "NO",
      pgType: row.udt_name || row.data_type,
    }));
  });
}

export async function queryColumns(connection: PgConnection, query: string): Promise<SourceColumn[]> {
  const statement = safeStatement(query);
  return withPg(connection, async (client) => {
    const result = await client.query({ text: `SELECT * FROM (${statement}) cw_source_probe LIMIT 0`, rowMode: "array" });
    return (result.fields ?? []).map((field) => ({
      originalName: field.name,
      sqlName: sqlIdentifier(field.name),
      sqlType: mapPgOid(field.dataTypeID),
      nullable: true,
      pgType: String(field.dataTypeID),
    }));
  });
}

export async function executePostgresReadOnly(connection: PgConnection, query: string, timeout = 30, limit = 10000) {
  const statement = safeStatement(query);
  return withPg(connection, async (client) => {
    await client.query(`SET statement_timeout TO ${Math.min(Math.max(timeout, 1), 120) * 1000}`);
    const started = Date.now();
    const result = await client.query(`SELECT * FROM (${statement}) cw_live_result LIMIT ${Math.min(Math.max(limit, 1), 10000) + 1}`);
    const rows = result.rows.slice(0, limit) as Record<string, unknown>[];
    return {
      columns: result.fields.map((f) => f.name),
      rows,
      rowCount: rows.length,
      truncated: result.rows.length > limit,
      executionTimeMs: Date.now() - started,
    };
  });
}

export async function* streamPostgresRows(connection: PgConnection, query: string, batchSize = 1000): AsyncGenerator<Record<string, unknown>[]> {
  const statement = safeStatement(query);
  const client = new Client(config(connection));
  await client.connect();
  try {
    let offset = 0;
    while (true) {
      const result = await client.query(`SELECT * FROM (${statement}) cw_extract_result LIMIT ${batchSize} OFFSET ${offset}`);
      if (!result.rows.length) break;
      yield result.rows as Record<string, unknown>[];
      if (result.rows.length < batchSize) break;
      offset += batchSize;
    }
  } finally {
    await client.end().catch(() => undefined);
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

function mapPgType(row: { data_type: string; udt_name: string; numeric_precision: number | null; numeric_scale: number | null }) {
  const type = (row.udt_name || row.data_type).toLowerCase();
  if (["int2", "int4", "int8", "smallint", "integer", "bigint"].includes(type)) return "BIGINT";
  if (["numeric", "decimal", "float4", "float8", "real", "double precision"].includes(type)) return "DECIMAL(18,4)";
  if (["date"].includes(type)) return "DATE";
  if (["timestamp", "timestamptz", "timestamp without time zone", "timestamp with time zone"].includes(type)) return "DATETIME2";
  if (["time", "timetz", "time without time zone", "time with time zone"].includes(type)) return "TIME";
  return "NVARCHAR(MAX)";
}

function mapPgOid(oid: number) {
  if ([20, 21, 23].includes(oid)) return "BIGINT";
  if ([700, 701, 1700].includes(oid)) return "DECIMAL(18,4)";
  if (oid === 1082) return "DATE";
  if ([1114, 1184].includes(oid)) return "DATETIME2";
  if ([1083, 1266].includes(oid)) return "TIME";
  return "NVARCHAR(MAX)";
}
