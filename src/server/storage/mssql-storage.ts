/**
 * MssqlStorageConnection — adapter SQL Server para dataset storage.
 * Thin wrapper em volta do pool existente de pool.ts.
 */

import sql from "mssql";
import type { ColDef, ColInfo, StorageConnection } from "./connection";

// ─── URL parsing ──────────────────────────────────────────────────────────────

function parseMssqlUrl(url: string): sql.config {
  const withoutScheme = url.replace(/^sqlserver:\/\//i, "");
  const [hostPort, ...rest] = withoutScheme.split(";").filter(Boolean);
  const [server, port] = (hostPort ?? "").split(":");
  const params = Object.fromEntries(
    rest.map((part) => {
      const i = part.indexOf("=");
      return [part.slice(0, i).toLowerCase(), part.slice(i + 1)];
    }),
  );
  return {
    server: server ?? "",
    port: port ? Number(port) : 1433,
    database: params.database,
    user: params.user,
    password: params.password,
    options: {
      encrypt: params.encrypt !== "false",
      trustServerCertificate: params.trustservercertificate === "true",
      packetSize: 16384,
    },
    requestTimeout: 600_000,
    connectionTimeout: 30_000,
    pool: { max: 10, min: 2, idleTimeoutMillis: 30_000 },
  };
}

// ─── Type mapping ─────────────────────────────────────────────────────────────

export function canonicalToMssql(sqlType: string): string {
  if (sqlType === "BIGINT") return "BIGINT";
  if (sqlType.startsWith("DECIMAL")) return "DECIMAL(18,4)";
  if (sqlType === "DATE") return "DATE";
  if (sqlType === "DATETIME2") return "DATETIME2";
  if (sqlType === "TIME") return "TIME";
  return "NVARCHAR(MAX)";
}

function mssqlToCanonical(r: {
  type_name: string;
  prec: number;
  scale: number;
}): string {
  const t = r.type_name.toLowerCase();
  if (t === "bigint") return "BIGINT";
  if (t === "decimal" || t === "numeric") return `DECIMAL(${r.prec},${r.scale})`;
  if (t === "date") return "DATE";
  if (t === "datetime2") return "DATETIME2";
  if (t === "time") return "TIME";
  return "NVARCHAR(MAX)";
}

// ─── Quoting ──────────────────────────────────────────────────────────────────

function mssqlQuote(name: string): string {
  return `[${name.replace(/]/g, "]]")}]`;
}

const esc = (s: string) => s.replaceAll("'", "''");

// ─── Pool cache ───────────────────────────────────────────────────────────────

const poolCache = new Map<string, Promise<sql.ConnectionPool>>();

function getPool(id: string, url: string): Promise<sql.ConnectionPool> {
  if (!poolCache.has(id)) {
    const pool = new sql.ConnectionPool(parseMssqlUrl(url));
    pool.on("error", () => { poolCache.delete(id); });
    const promise = pool.connect().catch((err) => { poolCache.delete(id); throw err; });
    poolCache.set(id, promise);
  }
  return poolCache.get(id)!;
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export class MssqlStorageConnection implements StorageConnection {
  readonly provider = "sqlserver" as const;
  private readonly _id: string;
  private readonly _url: string;

  constructor(id: string, url: string) {
    this._id = id;
    this._url = url;
  }

  /** Expõe o pool raw para o importer.ts (mantém compatibilidade) */
  async rawPool(): Promise<sql.ConnectionPool> {
    return getPool(this._id, this._url);
  }

  q(identifier: string): string {
    return mssqlQuote(identifier);
  }

  // ── Schema ──────────────────────────────────────────────────────────────────

  async createSchemaIfNotExists(schema: string): Promise<void> {
    const p = await this.rawPool();
    const q = mssqlQuote(schema);
    await p.request().query(`IF SCHEMA_ID(N'${esc(schema)}') IS NULL EXEC(N'CREATE SCHEMA ${q}')`);
  }

  async dropSchemaIfExists(schema: string): Promise<void> {
    const p = await this.rawPool();
    const q = mssqlQuote(schema);
    const tables = await p.request().query<{ name: string }>(
      `SELECT t.name FROM sys.tables t JOIN sys.schemas s ON t.schema_id=s.schema_id WHERE s.name=N'${esc(schema)}'`,
    );
    for (const row of tables.recordset) {
      await p.request().query(
        `IF OBJECT_ID(N'${esc(schema)}.${esc(row.name)}',N'U') IS NOT NULL DROP TABLE ${q}.${mssqlQuote(row.name)}`,
      );
    }
    await p.request().query(`IF SCHEMA_ID(N'${esc(schema)}') IS NOT NULL DROP SCHEMA ${q}`);
  }

  // ── Tables ──────────────────────────────────────────────────────────────────

  async tableExists(schema: string, table: string): Promise<boolean> {
    const p = await this.rawPool();
    const result = await p.request().query(
      `SELECT CASE WHEN OBJECT_ID(N'${esc(schema)}.${esc(table)}',N'U') IS NULL THEN 0 ELSE 1 END AS ok`,
    );
    return Number(result.recordset[0]?.ok) === 1;
  }

  async createTable(schema: string, table: string, cols: ColDef[]): Promise<void> {
    const p = await this.rawPool();
    const colDefs = cols
      .map(c => `${mssqlQuote(c.name)} ${canonicalToMssql(c.sqlType)}${c.nullable ? " NULL" : " NOT NULL"}`)
      .join(", ");
    await p.request().query(
      `CREATE TABLE ${mssqlQuote(schema)}.${mssqlQuote(table)} (${colDefs})`,
    );
  }

  async dropTableIfExists(schema: string, table: string): Promise<void> {
    const p = await this.rawPool();
    await p.request().query(
      `IF OBJECT_ID(N'${esc(schema)}.${esc(table)}',N'U') IS NOT NULL DROP TABLE ${mssqlQuote(schema)}.${mssqlQuote(table)}`,
    );
  }

  async renameTable(schema: string, oldName: string, newName: string): Promise<void> {
    const p = await this.rawPool();
    await p.request().query(`EXEC sp_rename N'${esc(schema)}.${esc(oldName)}', N'${esc(newName)}'`);
  }

  async listTables(schema: string): Promise<string[]> {
    const p = await this.rawPool();
    const result = await p.request().query<{ name: string }>(
      `SELECT t.name FROM sys.tables t JOIN sys.schemas s ON t.schema_id=s.schema_id WHERE s.name=N'${esc(schema)}' ORDER BY t.name`,
    );
    return result.recordset.map(r => r.name);
  }

  async listColumns(schema: string, table: string): Promise<ColInfo[]> {
    const p = await this.rawPool();
    const result = await p.request()
      .input("schema", sql.NVarChar, schema)
      .input("table", sql.NVarChar, table)
      .query<{ name: string; type_name: string; prec: number; scale: number; nullable: boolean }>(
        `SELECT c.name, ty.name type_name, c.precision prec, c.scale scale, c.is_nullable nullable
         FROM sys.columns c JOIN sys.types ty ON c.user_type_id=ty.user_type_id
         WHERE c.object_id=OBJECT_ID(QUOTENAME(@schema)+'.'+QUOTENAME(@table))
         ORDER BY c.column_id`,
      );
    return result.recordset.map(r => ({
      name: r.name,
      sqlType: mssqlToCanonical(r),
      nullable: r.nullable,
    }));
  }

  async countRows(schema: string, table: string): Promise<bigint> {
    const p = await this.rawPool();
    const result = await p.request().query(
      `SELECT COUNT_BIG(*) AS n FROM ${mssqlQuote(schema)}.${mssqlQuote(table)}`,
    );
    return BigInt(String(result.recordset[0]?.n ?? "0"));
  }

  // ── Raw SQL ─────────────────────────────────────────────────────────────────

  async query<T = Record<string, unknown>>(sqlStr: string): Promise<T[]> {
    const p = await this.rawPool();
    const result = await p.request().query(sqlStr);
    return result.recordset as T[];
  }

  async execute(sqlStr: string): Promise<number> {
    const p = await this.rawPool();
    const result = await p.request().query(sqlStr);
    return result.rowsAffected?.[0] ?? 0;
  }

  // ── Bulk insert ──────────────────────────────────────────────────────────────

  async bulkInsert(schema: string, table: string, cols: ColDef[], rows: unknown[][]): Promise<void> {
    if (!rows.length) return;
    const p = await this.rawPool();
    const bulk = new sql.Table(`${schema}.${table}`);
    bulk.create = false;
    for (const c of cols) bulk.columns.add(c.name, sql.NVarChar(sql.MAX), { nullable: true });
    for (const row of rows) {
      bulk.rows.add(...cols.map((_, j) => {
        const v = row[j];
        return v == null ? null : String(v);
      }) as Parameters<typeof bulk.rows.add>);
    }
    await new sql.Request(p).bulk(bulk);
  }

  // ── Transactions ─────────────────────────────────────────────────────────────

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    const p = await this.rawPool();
    const tx = new sql.Transaction(p);
    await tx.begin();
    try {
      const result = await fn();
      await tx.commit();
      return result;
    } catch (e) {
      await tx.rollback().catch(() => undefined);
      throw e;
    }
  }
}
