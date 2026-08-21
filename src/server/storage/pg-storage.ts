/**
 * PgStorageConnection — adapter PostgreSQL para dataset storage.
 * Usa pg.Pool com conexões persistentes.
 */

import { Pool, type PoolClient, type PoolConfig } from "pg";
import type { ColDef, ColInfo, StorageConnection } from "./connection";

// ─── URL parsing ──────────────────────────────────────────────────────────────

function parsePgUrl(url: string): PoolConfig {
  const normalized = url.replace(/^postgresql:\/\//, "postgres://");
  const u = new URL(normalized);
  const ssl = u.searchParams.get("sslmode") ?? u.searchParams.get("ssl");
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 5432,
    database: u.pathname.slice(1) || undefined,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    ssl: (!ssl || ssl === "disable") ? false : { rejectUnauthorized: ssl === "verify-full" },
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 30_000,
    statement_timeout: 600_000,
  };
}

// ─── Type mapping ─────────────────────────────────────────────────────────────

/** Canonical → Postgres type */
export function canonicalToPg(sqlType: string): string {
  if (sqlType === "BIGINT") return "BIGINT";
  if (sqlType.startsWith("DECIMAL")) return "NUMERIC(18,4)";
  if (sqlType === "DATE") return "DATE";
  if (sqlType === "DATETIME2") return "TIMESTAMP";
  if (sqlType === "TIME") return "TIME";
  return "TEXT"; // NVARCHAR(MAX) e qualquer outro
}

/** Postgres type → canonical */
function pgToCanonical(r: {
  data_type: string;
  numeric_precision: number | null;
  numeric_scale: number | null;
}): string {
  const dt = r.data_type.toLowerCase();
  if (dt === "bigint" || dt === "integer" || dt === "smallint") return "BIGINT";
  if (dt === "numeric" || dt === "decimal") return `DECIMAL(${r.numeric_precision ?? 18},${r.numeric_scale ?? 4})`;
  if (dt === "date") return "DATE";
  if (dt.startsWith("timestamp")) return "DATETIME2";
  if (dt === "time" || dt.startsWith("time ")) return "TIME";
  return "NVARCHAR(MAX)";
}

// ─── Quoting ──────────────────────────────────────────────────────────────────

export function pgQuote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// ─── Pool cache ───────────────────────────────────────────────────────────────

const poolCache = new Map<string, Pool>();

function getPool(id: string, url: string): Pool {
  if (!poolCache.has(id)) {
    const pool = new Pool(parsePgUrl(url));
    pool.on("error", () => { poolCache.delete(id); });
    poolCache.set(id, pool);
  }
  return poolCache.get(id)!;
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export class PgStorageConnection implements StorageConnection {
  readonly provider = "postgres" as const;
  readonly _pool: Pool;

  constructor(id: string, url: string) {
    this._pool = getPool(id, url);
  }

  q(identifier: string): string {
    return pgQuote(identifier);
  }

  // ── Schema ──────────────────────────────────────────────────────────────────

  async createSchemaIfNotExists(schema: string): Promise<void> {
    await this._pool.query(`CREATE SCHEMA IF NOT EXISTS ${pgQuote(schema)}`);
  }

  async dropSchemaIfExists(schema: string): Promise<void> {
    await this._pool.query(`DROP SCHEMA IF EXISTS ${pgQuote(schema)} CASCADE`);
  }

  // ── Tables ──────────────────────────────────────────────────────────────────

  async tableExists(schema: string, table: string): Promise<boolean> {
    const result = await this._pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = $2 AND table_type = 'BASE TABLE'
       ) AS exists`,
      [schema, table],
    );
    return result.rows[0]?.exists ?? false;
  }

  async createTable(schema: string, table: string, cols: ColDef[]): Promise<void> {
    const colDefs = cols
      .map(c => `${pgQuote(c.name)} ${canonicalToPg(c.sqlType)}${c.nullable ? "" : " NOT NULL"}`)
      .join(", ");
    await this._pool.query(
      `CREATE TABLE ${pgQuote(schema)}.${pgQuote(table)} (${colDefs})`,
    );
  }

  async dropTableIfExists(schema: string, table: string): Promise<void> {
    await this._pool.query(
      `DROP TABLE IF EXISTS ${pgQuote(schema)}.${pgQuote(table)}`,
    );
  }

  async renameTable(schema: string, oldName: string, newName: string): Promise<void> {
    await this._pool.query(
      `ALTER TABLE ${pgQuote(schema)}.${pgQuote(oldName)} RENAME TO ${pgQuote(newName)}`,
    );
  }

  async listTables(schema: string): Promise<string[]> {
    const result = await this._pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
      [schema],
    );
    return result.rows.map(r => r.table_name);
  }

  async listColumns(schema: string, table: string): Promise<ColInfo[]> {
    const result = await this._pool.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      numeric_precision: number | null;
      numeric_scale: number | null;
    }>(
      `SELECT column_name, data_type, is_nullable, numeric_precision, numeric_scale
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position`,
      [schema, table],
    );
    return result.rows.map(r => ({
      name: r.column_name,
      sqlType: pgToCanonical(r),
      nullable: r.is_nullable === "YES",
    }));
  }

  async countRows(schema: string, table: string): Promise<bigint> {
    const result = await this._pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM ${pgQuote(schema)}.${pgQuote(table)}`,
    );
    return BigInt(result.rows[0]?.n ?? "0");
  }

  // ── Raw SQL ─────────────────────────────────────────────────────────────────

  async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    const result = await this._pool.query(sql);
    return result.rows as T[];
  }

  async execute(sql: string): Promise<number> {
    const result = await this._pool.query(sql);
    return result.rowCount ?? 0;
  }

  /**
   * Executa SQL parametrizado. Usar quando colunas vêm de input externo
   * ou para unnest bulk inserts.
   */
  async queryParams<T = Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> {
    const result = await this._pool.query(sql, params);
    return result.rows as T[];
  }

  async executeParams(sql: string, params: unknown[]): Promise<number> {
    const result = await this._pool.query(sql, params);
    return result.rowCount ?? 0;
  }

  // ── Bulk insert ──────────────────────────────────────────────────────────────

  /**
   * Bulk insert via unnest() — eficiente para grandes volumes.
   * Cada coluna vira um array $N::text[] que é castado ao tipo destino.
   */
  async bulkInsert(schema: string, table: string, cols: ColDef[], rows: unknown[][]): Promise<void> {
    if (!rows.length) return;
    const qTable = `${pgQuote(schema)}.${pgQuote(table)}`;
    const colList = cols.map(c => pgQuote(c.name)).join(", ");
    const params: (string | null)[][] = cols.map(() => []);

    for (const row of rows) {
      for (let j = 0; j < cols.length; j++) {
        const v = row[j];
        params[j]!.push(v == null ? null : String(v));
      }
    }

    const unnestExprs = cols.map((c, i) =>
      `unnest($${i + 1}::text[])::${canonicalToPg(c.sqlType)}`,
    ).join(", ");

    await this._pool.query(
      `INSERT INTO ${qTable} (${colList}) SELECT ${unnestExprs}`,
      params,
    );
  }

  // ── Transactions ─────────────────────────────────────────────────────────────

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.withClient(async (client) => {
      await client.query("BEGIN");
      try {
        const result = await fn();
        await client.query("COMMIT");
        return result;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw e;
      }
    });
  }

  /**
   * Executa fn com um PoolClient dedicado (para transações multi-statement).
   */
  async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this._pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  /**
   * Bulk insert com cliente dedicado (dentro de transação).
   * rows[i][j] corresponde a cols[j].
   */
  async bulkInsertClient(
    client: PoolClient,
    schema: string,
    table: string,
    cols: ColDef[],
    rows: unknown[][],
  ): Promise<void> {
    if (!rows.length) return;
    const qTable = `${pgQuote(schema)}.${pgQuote(table)}`;
    const colList = cols.map(c => pgQuote(c.name)).join(", ");
    const params: (string | null)[][] = cols.map(() => []);

    for (const row of rows) {
      for (let j = 0; j < cols.length; j++) {
        const v = row[j];
        params[j]!.push(v == null ? null : String(v));
      }
    }

    const unnestExprs = cols.map((c, i) =>
      `unnest($${i + 1}::text[])::${canonicalToPg(c.sqlType)}`,
    ).join(", ");

    await client.query(
      `INSERT INTO ${qTable} (${colList}) SELECT ${unnestExprs}`,
      params,
    );
  }
}
