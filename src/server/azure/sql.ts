import * as Sentry from "@sentry/nextjs";
import sql from "mssql";
import { getStoragePool } from "@/server/storage/pool";
import { quoteIdentifier } from "@/server/security/naming";
import { validateReadOnlySql } from "@/server/security/sql-safety";
import { ApiError } from "@/server/http";
import { MAX_RESULT_BYTES, approxRowBytes } from "@/server/query/protection";

/** Returns the default storage pool (StorageServer with isDefault=true). */
export function sqlPool(): Promise<sql.ConnectionPool> {
  return getStoragePool(null);
}

export async function checkSql() {
  const started = Date.now();
  const pool = await sqlPool();
  const result = await pool.request().query("SELECT 1 AS ok, DB_NAME() AS database_name");
  return { latencyMs: Date.now() - started, database: result.recordset[0]?.database_name };
}

export async function ensureSchema(schema: string, pool?: sql.ConnectionPool) {
  const p = pool ?? await sqlPool();
  const q = quoteIdentifier(schema);
  await p.request().query(`IF SCHEMA_ID(N'${escapeSqlLiteral(schema)}') IS NULL EXEC(N'CREATE SCHEMA ${q}')`);
}

export async function dropTable(schema: string, table: string, storageServerId?: string | null) {
  const pool = storageServerId ? await getStoragePool(storageServerId) : await sqlPool();
  const q = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
  await pool.request().query(`IF OBJECT_ID(N'${escapeSqlLiteral(schema)}.${escapeSqlLiteral(table)}',N'U') IS NOT NULL DROP TABLE ${q}`);
}

export async function dropSchema(schema: string, storageServerId?: string | null) {
  const pool = storageServerId ? await getStoragePool(storageServerId) : await sqlPool();
  const q = quoteIdentifier(schema);
  const tables = await pool.request().query(`SELECT t.name FROM sys.tables t JOIN sys.schemas s ON t.schema_id=s.schema_id WHERE s.name=N'${escapeSqlLiteral(schema)}'`);
  for (const row of tables.recordset as { name: string }[]) await pool.request().query(`DROP TABLE ${q}.${quoteIdentifier(row.name)}`);
  await pool.request().query(`IF SCHEMA_ID(N'${escapeSqlLiteral(schema)}') IS NOT NULL DROP SCHEMA ${q}`);
}

export async function ensureInternalPrincipal(principal: string, storageServerId?: string | null) {
  const q = quoteIdentifier(principal);
  const pool = storageServerId ? await getStoragePool(storageServerId) : await sqlPool();
  await pool.request().query(`IF DATABASE_PRINCIPAL_ID(N'${escapeSqlLiteral(principal)}') IS NULL CREATE USER ${q} WITHOUT LOGIN`);
}

export async function grantSchema(principal: string, schema: string, permission: "READ" | "WRITE", storageServerId?: string | null) {
  const user = quoteIdentifier(principal), target = quoteIdentifier(schema);
  const grants = permission === "READ" ? ["SELECT"] : ["SELECT", "INSERT", "UPDATE", "DELETE"];
  const pool = storageServerId ? await getStoragePool(storageServerId) : await sqlPool();
  await pool.request().query(`IF DATABASE_PRINCIPAL_ID(N'${escapeSqlLiteral(principal)}') IS NULL CREATE USER ${user} WITHOUT LOGIN`);
  for (const grant of grants) await pool.request().query(`GRANT ${grant} ON SCHEMA::${target} TO ${user}`);
}

export async function batchGrantSchemas(principal: string, items: { schema: string; permission: "READ" | "WRITE" }[], storageServerId?: string | null) {
  if (items.length === 0) return;
  const pool = storageServerId ? await getStoragePool(storageServerId) : await sqlPool();
  // Garante que o principal existe neste banco antes de grantar
  const q = quoteIdentifier(principal);
  await pool.request().query(`IF DATABASE_PRINCIPAL_ID(N'${escapeSqlLiteral(principal)}') IS NULL CREATE USER ${q} WITHOUT LOGIN`);
  const user = quoteIdentifier(principal);
  // Build one statement per schema to avoid saturating the connection pool
  // (previously fired one request per permission per schema via Promise.all)
  for (const { schema, permission } of items) {
    const target = quoteIdentifier(schema);
    const perms = permission === "READ" ? ["SELECT"] : ["SELECT", "INSERT", "UPDATE", "DELETE"];
    const grants = perms.map((p) => `GRANT ${p} ON SCHEMA::${target} TO ${user}`).join("; ");
    // Guard: skip schemas that don't exist in the database (may exist in Prisma but not in SQL Server)
    await pool.request().query(
      `IF SCHEMA_ID(N'${escapeSqlLiteral(schema)}') IS NOT NULL BEGIN ${grants} END`,
    );
  }
}

export async function revokeSchema(principal: string, schema: string, storageServerId?: string | null) {
  const pool = storageServerId ? await getStoragePool(storageServerId) : await sqlPool();
  const user = quoteIdentifier(principal), target = quoteIdentifier(schema);
  for (const grant of ["SELECT", "INSERT", "UPDATE", "DELETE"]) await pool.request().query(`IF DATABASE_PRINCIPAL_ID(N'${escapeSqlLiteral(principal)}') IS NOT NULL REVOKE ${grant} ON SCHEMA::${target} FROM ${user}`);
}

async function qualifyStatementMssql(statement: string, schemas: string[], pool: sql.ConnectionPool): Promise<string> {
  const unqualified = extractUnqualifiedTableRefs(statement);
  if (unqualified.length === 0) return statement;

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

  let qualified = statement;
  for (const table of unqualified) {
    const found = tableMap.get(table.toLowerCase()) ?? [];
    if (found.length > 1) {
      throw new ApiError(400, "AMBIGUOUS_TABLE", `Tabela '${table}' existe em múltiplos datasets do contexto: ${found.join(", ")}. Use schema.tabela para qualificar.`);
    }
    if (found.length === 1) {
      qualified = qualifyTable(qualified, table, found[0]!);
    }
  }
  return qualified;
}

export async function executeReadOnly(principal: string, query: string, timeout = 30, limit = 10_000, schemas: string[] = [], offset = 0, maxTimeoutSeconds = 120, storageServerId?: string | null) {
  const validated = validateReadOnlySql(query);
  if (!validated.safe) throw new ApiError(400, "UNSAFE_SQL", validated.reason);

  let statement = validated.statement;

  if (schemas.length > 0) {
    const pool = storageServerId ? await getStoragePool(storageServerId) : await sqlPool();
    statement = await qualifyStatementMssql(statement, schemas, pool);
  }

  const pool = storageServerId ? await getStoragePool(storageServerId) : await sqlPool();
  const timeoutMs = Math.min(Math.max(timeout, 1), maxTimeoutSeconds) * 1000;
  const started = Date.now();

  // Sempre pagina no SQL Server (mesmo com offset=0) — antes, offset=0 rodava
  // a query sem LIMIT nenhum e trazia o recordset inteiro pro Node antes de
  // truncar em JS, o que por si só já podia estourar memória numa query sem
  // filtro. Pede limit+1 pra saber se existiam mais linhas do que o limite,
  // sem precisar de uma segunda query só de contagem; a linha extra é
  // descartada abaixo e nunca chega ao chamador.
  const fetchLimit = limit + 1;
  const hasCte = /^\s*WITH\b/i.test(statement);
  const paged = hasTopLevelOrderBy(statement)
    ? `${statement} OFFSET ${offset} ROWS FETCH NEXT ${fetchLimit} ROWS ONLY`
    : hasCte
      ? `${statement} ORDER BY (SELECT NULL) OFFSET ${offset} ROWS FETCH NEXT ${fetchLimit} ROWS ONLY`
      : `SELECT * FROM (${statement}) AS _cw_q ORDER BY (SELECT NULL) OFFSET ${offset} ROWS FETCH NEXT ${fetchLimit} ROWS ONLY`;

  try {
    return await new Promise<{ columns: string[]; rows: Record<string, unknown>[]; rowCount: number; truncated: boolean; executionTimeMs: number }>((resolve, reject) => {
      const request = new sql.Request(pool);
      // .timeout is a no-op in mssql v12; overrides.requestTimeout is the real field.
      (request as unknown as { timeout: number }).timeout = timeoutMs;
      (request as unknown as { overrides: { requestTimeout: number } }).overrides.requestTimeout = timeoutMs;
      // Streama linha a linha em vez de acumular o recordset inteiro no driver
      // — permite cancelar a query no MEIO da leitura quando o resultado já
      // ficou grande demais (colunas NVARCHAR(MAX)/TEXT largas), em vez de só
      // detectar isso tarde demais, depois que a memória já estourou.
      request.stream = true;

      let columns: string[] = [];
      const rows: Record<string, unknown>[] = [];
      let approxBytes = 0;
      let tooLarge = false;
      let settled = false;
      const finish = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

      request.on("recordset", (cols: Record<string, unknown>) => {
        columns = Object.keys(cols);
      });

      request.on("row", (row: Record<string, unknown>) => {
        if (tooLarge) return;
        rows.push(row);
        approxBytes += approxRowBytes(row);
        if (approxBytes > MAX_RESULT_BYTES) {
          tooLarge = true;
          request.cancel();
        }
      });

      request.on("error", (err: Error) => {
        finish(() => {
          if (tooLarge) {
            reject(new ApiError(
              413,
              "RESULT_TOO_LARGE",
              `Resultado excede ${Math.round(MAX_RESULT_BYTES / (1024 * 1024))}MB (colunas muito largas). Selecione menos colunas, filtre mais linhas, ou use "stream": true.`,
            ));
          } else {
            reject(err);
          }
        });
      });

      request.on("done", () => {
        finish(() => {
          const truncated = rows.length > limit;
          resolve({
            columns: columns.length ? columns : Object.keys(rows[0] ?? {}),
            rows: rows.slice(0, limit),
            rowCount: Math.min(rows.length, limit),
            truncated,
            executionTimeMs: Date.now() - started,
          });
        });
      });

      request.query(paged);
    });
  } catch (error) {
    Sentry.addBreadcrumb({
      category: "db.query",
      message: "executeReadOnly failed",
      level: "error",
      data: { sql: statement, principal, schemas },
    });
    throw error;
  }
}

/** Executa query em modo streaming NDJSON (sem limite de linhas, sem acumular no Node). */
export async function executeReadOnlyStream(
  principal: string,
  query: string,
  timeout = 60,
  schemas: string[] = [],
  storageServerId?: string | null,
): Promise<ReadableStream<Uint8Array>> {
  const validated = validateReadOnlySql(query);
  if (!validated.safe) throw new ApiError(400, "UNSAFE_SQL", validated.reason);

  let statement = validated.statement;

  if (schemas.length > 0) {
    const pool = storageServerId ? await getStoragePool(storageServerId) : await sqlPool();
    statement = await qualifyStatementMssql(statement, schemas, pool);
  }

  const pool = storageServerId ? await getStoragePool(storageServerId) : await sqlPool();
  const timeoutMs = Math.min(Math.max(timeout, 1), 300) * 1000;
  const encoder = new TextEncoder();
  const started = Date.now();

  // Se o cliente HTTP desconecta no meio do stream (timeout do lado dele,
  // fechou a conexão), o runtime chama cancel() abaixo e o controller já fica
  // fechado/inválido — mas a query no SQL Server continua rodando e os
  // eventos 'row'/'done'/'error' ainda disparam depois. Sem essa guarda,
  // controller.enqueue()/close() joga "Invalid state: Controller is
  // already closed" de dentro de um callback de EventEmitter — uma exceção
  // que ninguém captura, vira uncaughtException e derruba o processo Node
  // inteiro (não só essa request). `request` e `closed` ficam no escopo de
  // fora do `start` pra `cancel()` também poder enxergar e agir sobre eles.
  let request: sql.Request | undefined;
  let closed = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      request = new sql.Request(pool);
      (request as unknown as { timeout: number }).timeout = timeoutMs;
      (request as unknown as { overrides: { requestTimeout: number } }).overrides = { requestTimeout: timeoutMs };
      request.stream = true;

      let rowCount = 0;
      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          closed = true;
        }
      };
      const safeClose = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // já fechado pelo runtime (cliente desconectou) — ignora
        }
      };

      request.on("recordset", (columns: Record<string, unknown>) => {
        safeEnqueue(encoder.encode(JSON.stringify({ __columns__: Object.keys(columns) }) + "\n"));
      });

      request.on("row", (row: Record<string, unknown>) => {
        rowCount++;
        safeEnqueue(encoder.encode(JSON.stringify(row) + "\n"));
      });

      request.on("error", (err: Error) => {
        Sentry.addBreadcrumb({ category: "db.query", message: "executeReadOnlyStream failed", level: "error", data: { sql: statement, principal, schemas } });
        safeEnqueue(encoder.encode(JSON.stringify({ __error__: true, message: err.message }) + "\n"));
        safeClose();
      });

      request.on("done", () => {
        safeEnqueue(encoder.encode(JSON.stringify({ __done__: true, rowCount, executionTimeMs: Date.now() - started }) + "\n"));
        safeClose();
      });

      request.query(statement);
    },
    // Cliente desconectou/abortou: para de tentar escrever no controller e
    // cancela a query no SQL Server em vez de deixá-la rodar até o fim à toa.
    cancel() {
      request?.cancel();
    },
  });
}

function extractUnqualifiedTableRefs(sql: string): string[] {
  const tableKeywords = /\b(?:FROM|JOIN|INNER\s+JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|FULL\s+JOIN|CROSS\s+JOIN)\s+([a-zA-Z_][a-zA-Z0-9_]*)\b/gi;
  const results: string[] = [];
  let match;
  while ((match = tableKeywords.exec(sql)) !== null) {
    const ref = match[1]!;
    const idx = match.index + match[0].lastIndexOf(ref);
    if (sql[idx - 1] === ".") continue; // already schema-qualified (after dot)
    if (sql[idx + ref.length] === ".") continue; // is a schema name (before dot)
    results.push(ref);
  }
  return [...new Set(results)];
}

function hasTopLevelOrderBy(sql: string): boolean {
  let depth = 0;
  let i = 0;
  let found = false;
  while (i < sql.length) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")") depth--;
    else if (depth === 0 && /^ORDER\s+BY\b/i.test(sql.slice(i))) found = true;
    i++;
  }
  return found;
}

function qualifyTable(sql: string, table: string, schema: string): string {
  const qualified = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
  const pattern = new RegExp(`(?<!\\.)\\b${table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
  // Split on SQL string literals (N'...' or '...', with '' escapes) so we don't replace inside them
  const parts = sql.split(/(N?'[^']*(?:''[^']*)*')/gi);
  return parts.map((part, i) => {
    if (i % 2 === 1) return part; // string literal — skip
    return part.replace(pattern, (match, offset) => {
      // Skip if preceded by AS keyword (column alias: SELECT x AS name)
      const before = part.slice(0, offset).trimEnd();
      if (/\bAS$/i.test(before)) return match;
      // Skip if followed by AS ( (CTE definition: WITH name AS (...))
      const after = part.slice(offset + match.length).trimStart();
      if (/^AS\s*\(/i.test(after)) return match;
      return qualified;
    });
  }).join("");
}

export async function createExternalDatabaseUser(name: string, password: string, storageServerId?: string | null) {
  const pool = storageServerId ? await getStoragePool(storageServerId) : await sqlPool();
  const q = quoteIdentifier(name);
  await pool.request().query(`IF DATABASE_PRINCIPAL_ID(N'${escapeSqlLiteral(name)}') IS NOT NULL DROP USER ${q}; CREATE USER ${q} WITH PASSWORD = N'${escapeSqlLiteral(password)}'`);
}
export async function rotateExternalDatabaseUser(name: string, password: string, storageServerId?: string | null) {
  const pool = storageServerId ? await getStoragePool(storageServerId) : await sqlPool();
  await pool.request().query(`ALTER USER ${quoteIdentifier(name)} WITH PASSWORD = N'${escapeSqlLiteral(password)}'`);
}
export async function dropExternalDatabaseUser(name: string, storageServerId?: string | null) {
  const pool = storageServerId ? await getStoragePool(storageServerId) : await sqlPool();
  await pool.request().query(`IF DATABASE_PRINCIPAL_ID(N'${escapeSqlLiteral(name)}') IS NOT NULL DROP USER ${quoteIdentifier(name)}`);
}
export const escapeSqlLiteral = (value: string) => value.replaceAll("'", "''");