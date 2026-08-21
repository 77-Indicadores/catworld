/**
 * Execução de queries somente-leitura sobre um PgStorageConnection.
 * Equivalente ao executeReadOnly de azure/sql.ts mas para PostgreSQL.
 *
 * O SQL de entrada deve estar no dialeto T-SQL (MSSQL) — este módulo
 * chama translateMssqlToPg antes de executar.
 */

import type { PoolClient } from "pg";
import { validateReadOnlySql } from "@/server/security/sql-safety";
import { ApiError } from "@/server/http";
import { translateMssqlToPg } from "./mssql-to-pg";
import type { PgStorageConnection } from "./pg-storage";

const DEFAULT_LIMIT = 10_000;

export async function executeReadOnlyPg(
  conn: PgStorageConnection,
  sql: string,
  timeout = 30,
  limit = DEFAULT_LIMIT,
  schemas: string[] = [],
  offset = 0,
): Promise<{
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  executionTimeMs: number;
}> {
  const validated = validateReadOnlySql(sql);
  if (!validated.safe) throw new ApiError(400, "UNSAFE_SQL", validated.reason);

  const { sql: translated, topLimit } = translateMssqlToPg(validated.statement);

  // Qualifica tabelas sem schema usando information_schema
  let statement = translated;
  if (schemas.length > 0) {
    statement = await qualifyTablesForPg(conn, statement, schemas);
  }

  // Monta query paginada
  const effectiveLimit = topLimit ?? limit;
  let paged: string;

  if (topLimit !== null) {
    // TOP N já foi extraído — adiciona LIMIT ao final
    paged = `${statement} LIMIT ${topLimit}`;
    if (offset > 0) paged += ` OFFSET ${offset}`;
  } else if (offset > 0) {
    paged = `SELECT * FROM (${statement}) AS _cw_q LIMIT ${effectiveLimit} OFFSET ${offset}`;
  } else {
    paged = `SELECT * FROM (${statement}) AS _cw_q LIMIT ${effectiveLimit}`;
  }

  const timeoutMs = Math.min(Math.max(timeout, 1), 120) * 1000;

  const started = Date.now();
  let client: PoolClient | null = null;
  try {
    client = await conn._pool.connect();
    await client.query(`SET statement_timeout = ${timeoutMs}`);

    // Define search_path para permitir referências sem schema
    if (schemas.length > 0) {
      const searchPath = schemas.map((s) => `"${s.replace(/"/g, '""')}"`).join(", ");
      await client.query(`SET search_path TO ${searchPath}, public`);
    }

    const result = await client.query(paged);
    const rows = (result.rows as Record<string, unknown>[]).slice(0, effectiveLimit);
    const columns = result.fields.map((f) => f.name);

    return {
      columns,
      rows,
      rowCount: rows.length,
      truncated: result.rows.length > effectiveLimit,
      executionTimeMs: Date.now() - started,
    };
  } finally {
    client?.release();
  }
}

/** Streaming NDJSON sem limite de linhas — executa query completa e emite linha a linha. */
export async function executeReadOnlyPgStream(
  conn: PgStorageConnection,
  sql: string,
  timeout = 60,
  schemas: string[] = [],
): Promise<ReadableStream<Uint8Array>> {
  const validated = validateReadOnlySql(sql);
  if (!validated.safe) throw new ApiError(400, "UNSAFE_SQL", validated.reason);

  const { sql: translated } = translateMssqlToPg(validated.statement);
  let statement = translated;
  if (schemas.length > 0) {
    statement = await qualifyTablesForPg(conn, statement, schemas);
  }

  const timeoutMs = Math.min(Math.max(timeout, 1), 300) * 1000;
  const encoder = new TextEncoder();
  const started = Date.now();

  // Executa a query completa e emite as linhas em stream
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let client: PoolClient | null = null;
      try {
        client = await conn._pool.connect();
        await client.query(`SET statement_timeout = ${timeoutMs}`);
        if (schemas.length > 0) {
          const searchPath = schemas.map((s) => `"${s.replace(/"/g, '""')}"`).join(", ");
          await client.query(`SET search_path TO ${searchPath}, public`);
        }
        const result = await client.query(statement);
        const columns = result.fields.map((f) => f.name);
        controller.enqueue(encoder.encode(JSON.stringify({ __columns__: columns }) + "\n"));
        let rowCount = 0;
        for (const row of result.rows as Record<string, unknown>[]) {
          controller.enqueue(encoder.encode(JSON.stringify(row) + "\n"));
          rowCount++;
        }
        controller.enqueue(encoder.encode(JSON.stringify({ __done__: true, rowCount, executionTimeMs: Date.now() - started }) + "\n"));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        controller.enqueue(encoder.encode(JSON.stringify({ __error__: true, message: msg }) + "\n"));
      } finally {
        client?.release();
        controller.close();
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Qualificação de tabelas não qualificadas via information_schema
// ---------------------------------------------------------------------------

async function qualifyTablesForPg(
  conn: PgStorageConnection,
  sql: string,
  schemas: string[],
): Promise<string> {
  const unqualified = extractUnqualifiedTableRefs(sql);
  if (unqualified.length === 0) return sql;

  const placeholders = schemas.map((_, i) => `$${i + 1}`).join(", ");
  const tableNames = unqualified.map((_, i) => `$${schemas.length + i + 1}`).join(", ");

  const res = await conn._pool.query<{ table_schema: string; table_name: string }>(
    `SELECT table_schema, table_name
       FROM information_schema.tables
      WHERE table_schema IN (${placeholders})
        AND table_name   IN (${tableNames})`,
    [...schemas, ...unqualified],
  );

  const tableMap = new Map<string, string[]>();
  for (const row of res.rows) {
    const key = row.table_name.toLowerCase();
    if (!tableMap.has(key)) tableMap.set(key, []);
    tableMap.get(key)!.push(row.table_schema);
  }

  let result = sql;
  for (const table of unqualified) {
    const found = tableMap.get(table.toLowerCase()) ?? [];
    if (found.length > 1) {
      throw new ApiError(
        400,
        "AMBIGUOUS_TABLE",
        `Tabela '${table}' existe em múltiplos datasets do contexto: ${found.join(", ")}. Use schema.tabela para qualificar.`,
      );
    }
    if (found.length === 1) {
      result = qualifyTable(result, table, found[0]!);
    }
  }

  return result;
}

function extractUnqualifiedTableRefs(sql: string): string[] {
  const re = /\b(?:FROM|JOIN|INNER\s+JOIN|LEFT\s+(?:OUTER\s+)?JOIN|RIGHT\s+(?:OUTER\s+)?JOIN|FULL\s+(?:OUTER\s+)?JOIN|CROSS\s+JOIN)\s+("?[a-zA-Z_][a-zA-Z0-9_]*"?)\b/gi;
  const results: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql)) !== null) {
    const ref = match[1]!.replace(/"/g, "");
    const idx = match.index + match[0].lastIndexOf(match[1]!);
    if (sql[idx - 1] === "." || sql[idx + match[1]!.length] === ".") continue;
    results.push(ref);
  }
  return [...new Set(results)];
}

function qualifyTable(sql: string, table: string, schema: string): string {
  const qualified = `"${schema.replace(/"/g, '""')}"."${table.replace(/"/g, '""')}"`;
  const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?<!\\.)"?\\b${escaped}\\b"?`, "gi");
  // Processa fora de literais de string
  const parts = sql.split(/(N?'[^']*(?:''[^']*)*')/gi);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part.replace(pattern, (match, offset) => {
        const before = part.slice(0, offset).trimEnd();
        if (/\bAS$/i.test(before)) return match;
        const after = part.slice(offset + match.length).trimStart();
        if (/^AS\s*\(/i.test(after)) return match;
        return qualified;
      });
    })
    .join("");
}
