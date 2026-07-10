import sql from "mssql";
import { env } from "@/server/env";
import { quoteIdentifier } from "@/server/security/naming";
import { validateReadOnlySql } from "@/server/security/sql-safety";
import { ApiError } from "@/server/http";

function parsePrismaSqlServerUrl(url: string): sql.config {
  const withoutScheme = url.replace(/^sqlserver:\/\//i, "");
  const [hostPort, ...rest] = withoutScheme.split(";").filter(Boolean);
  const [server, port] = hostPort.split(":");
  const params = Object.fromEntries(rest.map((part) => { const i = part.indexOf("="); return [part.slice(0, i).toLowerCase(), part.slice(i + 1)]; }));
  if (!server) throw new Error("CATWORLD_DATABASE_URL inválida: host ausente");
  return {
    server,
    port: port ? Number(port) : 1433,
    database: params.database,
    user: params.user,
    password: params.password,
    options: { encrypt: params.encrypt !== "false", trustServerCertificate: params.trustservercertificate === "true", packetSize: 16384 },
    requestTimeout: 600_000,
    connectionTimeout: 30_000,
    pool: { max: 10, min: 2, idleTimeoutMillis: 30_000 },
  };
}

const globalPool = globalThis as unknown as { catworldSqlPool?: Promise<sql.ConnectionPool> };
export function sqlPool() {
  if (!globalPool.catworldSqlPool) {
    const pool = new sql.ConnectionPool(parsePrismaSqlServerUrl(env().CATWORLD_DATABASE_URL));
    pool.on("error", () => { if (globalPool.catworldSqlPool) globalPool.catworldSqlPool = undefined; });
    globalPool.catworldSqlPool = pool.connect().catch((err) => { globalPool.catworldSqlPool = undefined; throw err; });
  }
  return globalPool.catworldSqlPool;
}

export async function checkSql() {
  const started = Date.now();
  const pool = await sqlPool();
  const result = await pool.request().query("SELECT 1 AS ok, DB_NAME() AS database_name");
  return { latencyMs: Date.now() - started, database: result.recordset[0]?.database_name };
}

export async function ensureSchema(schema: string) {
  const q = quoteIdentifier(schema);
  await (await sqlPool()).request().query(`IF SCHEMA_ID(N'${escapeSqlLiteral(schema)}') IS NULL EXEC(N'CREATE SCHEMA ${q}')`);
}

export async function dropTable(schema: string, table: string) {
  const q = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
  await (await sqlPool()).request().query(`IF OBJECT_ID(N'${escapeSqlLiteral(schema)}.${escapeSqlLiteral(table)}',N'U') IS NOT NULL DROP TABLE ${q}`);
}

export async function dropSchema(schema: string) {
  const pool = await sqlPool();
  const q = quoteIdentifier(schema);
  const tables = await pool.request().query(`SELECT t.name FROM sys.tables t JOIN sys.schemas s ON t.schema_id=s.schema_id WHERE s.name=N'${escapeSqlLiteral(schema)}'`);
  for (const row of tables.recordset as { name: string }[]) await pool.request().query(`DROP TABLE ${q}.${quoteIdentifier(row.name)}`);
  await pool.request().query(`IF SCHEMA_ID(N'${escapeSqlLiteral(schema)}') IS NOT NULL DROP SCHEMA ${q}`);
}

export async function ensureInternalPrincipal(principal: string) {
  const q = quoteIdentifier(principal);
  await (await sqlPool()).request().query(`IF DATABASE_PRINCIPAL_ID(N'${escapeSqlLiteral(principal)}') IS NULL CREATE USER ${q} WITHOUT LOGIN`);
}

export async function grantSchema(principal: string, schema: string, permission: "READ" | "WRITE") {
  const user = quoteIdentifier(principal), target = quoteIdentifier(schema);
  const grants = permission === "READ" ? ["SELECT"] : ["SELECT", "INSERT", "UPDATE", "DELETE"];
  await ensureInternalPrincipal(principal);
  for (const grant of grants) await (await sqlPool()).request().query(`GRANT ${grant} ON SCHEMA::${target} TO ${user}`);
}

export async function revokeSchema(principal: string, schema: string) {
  const user = quoteIdentifier(principal), target = quoteIdentifier(schema);
  for (const grant of ["SELECT", "INSERT", "UPDATE", "DELETE"]) await (await sqlPool()).request().query(`IF DATABASE_PRINCIPAL_ID(N'${escapeSqlLiteral(principal)}') IS NOT NULL REVOKE ${grant} ON SCHEMA::${target} FROM ${user}`);
}

export async function executeReadOnly(principal: string, query: string, timeout = 30, limit = 10_000, schemas: string[] = [], offset = 0) {
  const validated = validateReadOnlySql(query);
  if (!validated.safe) throw new ApiError(400, "UNSAFE_SQL", validated.reason);

  let statement = validated.statement;

  if (schemas.length > 0) {
    const pool = await sqlPool();
    const unqualified = extractUnqualifiedTableRefs(statement);

    if (unqualified.length > 0) {
      const schemaList = schemas.map(s => `N'${escapeSqlLiteral(s)}'`).join(", ");
      const tableList = unqualified.map(t => `N'${escapeSqlLiteral(t)}'`).join(", ");
      const lookup = await pool.request().query(
        `SELECT s.name AS schemaName, t.name AS tableName FROM sys.tables t JOIN sys.schemas s ON t.schema_id = s.schema_id WHERE s.name IN (${schemaList}) AND t.name IN (${tableList})`
      );

const tableMap = new Map<string, string[]>();
      for (const row of lookup.recordset as { schemaName: string; tableName: string }[]) {
        const key = row.tableName.toLowerCase();
        if (!tableMap.has(key)) tableMap.set(key, []);
        tableMap.get(key)!.push(row.schemaName);
      }

      for (const table of unqualified) {
        const found = tableMap.get(table.toLowerCase()) ?? [];
        if (found.length > 1) {
          throw new ApiError(400, "AMBIGUOUS_TABLE", `Tabela '${table}' existe em múltiplos datasets do contexto: ${found.join(", ")}. Use schema.tabela para qualificar.`);
        }
        if (found.length === 1) {
          statement = qualifyTable(statement, table, found[0]!);
        }
        if (found.length === 0) {
          throw new ApiError(400, "TABLE_NOT_FOUND", `Tabela '${table}' não encontrada no contexto informado. Verifique o dataset_id ou project_id.`);
        }
      }
    }
  }

  const pool = await sqlPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const request = new sql.Request(transaction);
    (request as unknown as { timeout: number }).timeout = Math.min(Math.max(timeout, 1), 120) * 1000;
    await request.query(`EXECUTE AS USER = N'${escapeSqlLiteral(principal)}'`);
    const started = Date.now();
    const paged = offset > 0 || limit < 10_000
      ? `SELECT * FROM (${statement}) AS _cw_q ORDER BY (SELECT NULL) OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`
      : statement;
    const result = await request.query(paged);
    const rows = result.recordset?.slice(0, limit) ?? [];
    await request.query("REVERT");
    await transaction.commit();
    return { columns: result.recordset?.columns ? Object.keys(result.recordset.columns) : Object.keys(rows[0] ?? {}), rows, rowCount: rows.length, truncated: (result.recordset?.length ?? 0) > limit, executionTimeMs: Date.now() - started };
  } catch (error) {
    await transaction.rollback().catch(() => undefined);
    throw error;
  }
}

function extractUnqualifiedTableRefs(sql: string): string[] {
  const tableKeywords = /\b(?:FROM|JOIN|INNER\s+JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|FULL\s+JOIN|CROSS\s+JOIN)\s+([a-zA-Z_][a-zA-Z0-9_]*)\b/gi;
  const results: string[] = [];
  let match;
  while ((match = tableKeywords.exec(sql)) !== null) {
    const ref = match[1]!;
    // skip if already qualified (preceded by a dot)
    const idx = match.index + match[0].lastIndexOf(ref);
    if (sql[idx - 1] !== ".") results.push(ref);
  }
  return [...new Set(results)];
}

function qualifyTable(sql: string, table: string, schema: string): string {
  return sql.replace(new RegExp(`(?<!\\.)\\b${table}\\b`, "gi"), `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`);
}

export async function createExternalDatabaseUser(name: string, password: string) {
  const q = quoteIdentifier(name);
  await (await sqlPool()).request().query(`IF DATABASE_PRINCIPAL_ID(N'${escapeSqlLiteral(name)}') IS NOT NULL DROP USER ${q}; CREATE USER ${q} WITH PASSWORD = N'${escapeSqlLiteral(password)}'`);
}
export async function rotateExternalDatabaseUser(name: string, password: string) {
  await (await sqlPool()).request().query(`ALTER USER ${quoteIdentifier(name)} WITH PASSWORD = N'${escapeSqlLiteral(password)}'`);
}
export async function dropExternalDatabaseUser(name: string) {
  await (await sqlPool()).request().query(`IF DATABASE_PRINCIPAL_ID(N'${escapeSqlLiteral(name)}') IS NOT NULL DROP USER ${quoteIdentifier(name)}`);
}
export const escapeSqlLiteral = (value: string) => value.replaceAll("'", "''");