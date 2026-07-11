import sql from "mssql";
import { decryptSecret } from "@/server/security/crypto";
import { validateReadOnlySql } from "@/server/security/sql-safety";
import { sqlIdentifier } from "@/server/security/naming";
import { ApiError } from "@/server/http";
import type { SourceColumn } from "./postgres";

export type MssqlConnection = {
  server: string;
  port: number | null;
  databaseName: string;
  sslMode: string;
  username: string;
  encryptedCredentials: string;
};

function parseSslMode(sslMode: string): { encrypt: boolean; trustServerCertificate: boolean } {
  const trust = sslMode.includes("trust");
  const encrypt = !sslMode.startsWith("no-");
  return { encrypt, trustServerCertificate: trust };
}

function config(connection: MssqlConnection): sql.config {
  const { password } = JSON.parse(decryptSecret(connection.encryptedCredentials)) as { password: string };
  const { encrypt, trustServerCertificate } = parseSslMode(connection.sslMode || "encrypt");
  return {
    server: connection.server,
    port: connection.port ?? 1433,
    database: connection.databaseName,
    user: connection.username,
    password,
    options: { encrypt, trustServerCertificate },
    connectionTimeout: 10000,
    requestTimeout: 120000,
  };
}

async function withMssql<T>(connection: MssqlConnection, fn: (pool: sql.ConnectionPool) => Promise<T>): Promise<T> {
  const pool = new sql.ConnectionPool(config(connection));
  await pool.connect();
  try {
    return await fn(pool);
  } finally {
    await pool.close().catch(() => undefined);
  }
}

export async function testMssql(connection: MssqlConnection) {
  const started = Date.now();
  const result = await withMssql(connection, (pool) =>
    pool.request().query<{ database_name: string }>("SELECT DB_NAME() AS database_name"),
  );
  return { latencyMs: Date.now() - started, database: result.recordset[0]?.database_name };
}

export async function listSchemasMssql(connection: MssqlConnection) {
  return withMssql(connection, async (pool) => {
    const result = await pool.request().query<{ schema: string }>(
      `SELECT schema_name AS [schema] FROM INFORMATION_SCHEMA.SCHEMATA
       WHERE schema_name NOT IN ('sys','INFORMATION_SCHEMA','db_owner','db_accessadmin','db_securityadmin','db_ddladmin','db_backupoperator','db_datareader','db_datawriter','db_denydatareader','db_denydatawriter','guest')
       ORDER BY schema_name`,
    );
    return result.recordset;
  });
}

export async function listTablesMssql(connection: MssqlConnection, schema?: string) {
  return withMssql(connection, async (pool) => {
    const req = pool.request();
    const whereSchema = schema ? (req.input("schema", sql.NVarChar(128), schema), " AND TABLE_SCHEMA=@schema") : "";
    const result = await req.query<{ schema: string; table: string }>(
      `SELECT TABLE_SCHEMA AS [schema], TABLE_NAME AS [table] FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE'${whereSchema} ORDER BY TABLE_SCHEMA, TABLE_NAME`,
    );
    return result.recordset;
  });
}

export async function tableColumnsMssql(connection: MssqlConnection, schema: string, table: string): Promise<SourceColumn[]> {
  return withMssql(connection, async (pool) => {
    const result = await pool.request()
      .input("schema", sql.NVarChar(128), schema)
      .input("table", sql.NVarChar(128), table)
      .query<{ column_name: string; data_type: string; is_nullable: string }>(
        `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=@schema AND TABLE_NAME=@table ORDER BY ORDINAL_POSITION`,
      );
    return result.recordset.map((row) => ({
      originalName: row.column_name,
      sqlName: sqlIdentifier(row.column_name),
      sqlType: mapMssqlType(row.data_type),
      nullable: row.is_nullable !== "NO",
    }));
  });
}

export async function queryColumnsMssql(connection: MssqlConnection, query: string): Promise<SourceColumn[]> {
  const statement = safeStatementMssql(query);
  return withMssql(connection, async (pool) => {
    const result = await pool.request().query(`SELECT TOP 0 * FROM (${statement}) cw_source_probe`);
    const cols = result.recordset.columns as Record<string, { name: string; type: unknown; nullable?: boolean }> | undefined;
    if (!cols) return [];
    return Object.values(cols).map((col) => ({
      originalName: col.name,
      sqlName: sqlIdentifier(col.name),
      sqlType: mapMssqlColType(col.type),
      nullable: col.nullable ?? true,
    }));
  });
}

export async function executeMssqlReadOnly(connection: MssqlConnection, query: string, timeout = 30, limit = 10000, offset = 0) {
  const statement = safeStatementMssql(query);
  const clampedTimeout = Math.min(Math.max(timeout, 1), 120) * 1000;
  const pool = new sql.ConnectionPool({ ...config(connection), requestTimeout: clampedTimeout });
  await pool.connect();
  try {
    const req = pool.request();
    const started = Date.now();
    const clampedLimit = Math.min(Math.max(limit, 1), 10000);
    const result = await req.query(
      `SELECT * FROM (${statement}) cw_live_result ORDER BY (SELECT NULL) OFFSET ${Math.max(offset, 0)} ROWS FETCH NEXT ${clampedLimit + 1} ROWS ONLY`,
    );
    const rows = result.recordset.slice(0, clampedLimit) as Record<string, unknown>[];
    const cols = result.recordset.columns as Record<string, { name: string }> | undefined;
    return {
      columns: cols ? Object.values(cols).map((c) => c.name) : rows.length ? Object.keys(rows[0]!) : [],
      rows,
      rowCount: rows.length,
      truncated: result.recordset.length > clampedLimit,
      executionTimeMs: Date.now() - started,
    };
  } finally {
    await pool.close().catch(() => undefined);
  }
}

export async function* streamMssqlRows(connection: MssqlConnection, query: string, batchSize = 1000): AsyncGenerator<Record<string, unknown>[]> {
  const statement = safeStatementMssql(query);
  const pool = new sql.ConnectionPool(config(connection));
  await pool.connect();
  try {
    let offset = 0;
    while (true) {
      const result = await pool.request().query(
        `SELECT * FROM (${statement}) cw_extract_result ORDER BY (SELECT NULL) OFFSET ${offset} ROWS FETCH NEXT ${batchSize} ROWS ONLY`,
      );
      if (!result.recordset.length) break;
      yield result.recordset as Record<string, unknown>[];
      if (result.recordset.length < batchSize) break;
      offset += batchSize;
    }
  } finally {
    await pool.close().catch(() => undefined);
  }
}

export function safeStatementMssql(query: string) {
  const validated = validateReadOnlySql(query);
  if (!validated.safe) throw new ApiError(400, "UNSAFE_SQL", validated.reason);
  return validated.statement;
}

export function quotedMssqlTable(schema: string, table: string) {
  return `[${schema.replaceAll("]", "]]")}].[${table.replaceAll("]", "]]")}]`;
}

function mapMssqlType(dataType: string): string {
  const t = dataType.toLowerCase();
  if (["bigint", "int", "smallint", "tinyint"].includes(t)) return "BIGINT";
  if (["decimal", "numeric", "float", "real", "money", "smallmoney"].includes(t)) return "DECIMAL(18,4)";
  if (t === "date") return "DATE";
  if (["datetime", "datetime2", "smalldatetime", "datetimeoffset"].includes(t)) return "DATETIME2";
  if (t === "time") return "TIME";
  return "NVARCHAR(MAX)";
}

const mssqlTypeMap = new Map<unknown, string>([
  [sql.BigInt, "BIGINT"],
  [sql.Int, "BIGINT"],
  [sql.SmallInt, "BIGINT"],
  [sql.TinyInt, "BIGINT"],
  [sql.Decimal, "DECIMAL(18,4)"],
  [sql.Numeric, "DECIMAL(18,4)"],
  [sql.Float, "DECIMAL(18,4)"],
  [sql.Real, "DECIMAL(18,4)"],
  [sql.Money, "DECIMAL(18,4)"],
  [sql.SmallMoney, "DECIMAL(18,4)"],
  [sql.Date, "DATE"],
  [sql.DateTime, "DATETIME2"],
  [sql.DateTime2, "DATETIME2"],
  [sql.SmallDateTime, "DATETIME2"],
  [sql.DateTimeOffset, "DATETIME2"],
  [sql.Time, "TIME"],
]);

function mapMssqlColType(colType: unknown): string {
  return mssqlTypeMap.get(colType) ?? "NVARCHAR(MAX)";
}
