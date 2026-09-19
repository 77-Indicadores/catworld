/**
 * Execução de queries somente-leitura sobre um PgStorageConnection.
 * Equivalente ao executeReadOnly de azure/sql.ts mas para PostgreSQL.
 *
 * O SQL de entrada deve estar no dialeto T-SQL (MSSQL) — este módulo
 * passa pelo contrato de SQL (sql-contract/translate) antes de executar.
 */

import { Query, type PoolClient } from "pg";
import { validateReadOnlySql } from "@/server/security/sql-safety";
import { ApiError, isQueryTimeout, publicQueryErrorMessage } from "@/server/http";
import { dedupeColumnNames, rowsFromArrays } from "@/server/sql-contract/columns";
import { legacyFormatColumns } from "@/server/sql-contract/result";
import { MAX_RESULT_BYTES, approxRowBytes } from "@/server/query/protection";
import { contractTranslate, getContractMode, runWithContract } from "@/server/sql-contract/apply";
import { pgQuote, type PgStorageConnection } from "./pg-storage";
import { mssqlKind, normalizeRows, pgKind, type ColumnKind } from "@/server/sql-contract/result";

const DEFAULT_LIMIT = 10_000;

/**
 * Abre a transacao da consulta: SOMENTE LEITURA (bloqueia SELECT INTO, nextval, lo_import… no proprio
 * banco), timeout e search_path locais e, para nao-admin, `SET LOCAL ROLE` no papel do ator (so enxerga
 * os schemas dos datasets a que tem acesso — ver pg-roles.ts).
 */
async function beginReadOnly(
  client: PoolClient,
  o: { timeoutMs: number; role: string | null; schemas: string[] },
): Promise<void> {
  await client.query("BEGIN READ ONLY");
  await client.query(`SET LOCAL statement_timeout = ${Math.floor(o.timeoutMs)}`);
  if (o.role) await client.query(`SET LOCAL ROLE ${pgQuote(o.role)}`);
  if (o.schemas.length > 0) {
    await client.query(`SET LOCAL search_path TO ${o.schemas.map(pgQuote).join(", ")}, public`);
  }
}

async function endTx(client: PoolClient | null): Promise<void> {
  if (!client) return;
  try { await client.query("ROLLBACK"); } catch { /* conexao ja quebrada: o pool descarta */ }
}

export async function executeReadOnlyPg(
  conn: PgStorageConnection,
  sql: string,
  timeout = 30,
  limit = DEFAULT_LIMIT,
  schemas: string[] = [],
  offset = 0,
  normalize = false,
  role: string | null = null,
): Promise<{
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  executionTimeMs: number;
  legacyFormatColumns?: string[];
}> {
  const validated = validateReadOnlySql(sql);
  if (!validated.safe) throw new ApiError(400, "UNSAFE_SQL", validated.reason);

  return runWithContract(validated.statement, "postgres", "storage-pg", "regex", async ({ sql: translated, topLimit }) => {
  // Qualifica tabelas sem schema usando information_schema
  let statement = translated;
  if (schemas.length > 0) {
    statement = await qualifyTablesForPg(conn, statement, schemas);
  }

  // Monta query paginada
  // Contrato: `TOP n` limita o CONJUNTO; limit/offset paginam DENTRO dele (igual ao SQL Server, que aplica o TOP na
  // subconsulta). O teto de 10000 por pagina vale sempre. Antes o TOP virava o LIMIT de fora e o offset valia ANTES dele.
  const effectiveLimit = limit;
  const inner = topLimit !== null ? `${statement} LIMIT ${topLimit}` : statement;
  const paged = offset > 0
    ? `SELECT * FROM (${inner}) AS _cw_q LIMIT ${effectiveLimit + 1} OFFSET ${offset}`
    : `SELECT * FROM (${inner}) AS _cw_q LIMIT ${effectiveLimit + 1}`;

  const timeoutMs = Math.min(Math.max(timeout, 1), 120) * 1000;

  const started = Date.now();
  let client: PoolClient | null = null;
  try {
    client = await conn._pool.connect();
    // Transacao SOMENTE LEITURA + papel do ator; SET LOCAL nao vaza para a proxima consulta do pool.
    await beginReadOnly(client, { timeoutMs, role, schemas });

    // O LIMIT acima protege contra número de linhas, mas não contra colunas
    // muito largas (TEXT/JSONB sem teto de tamanho) — um resultado "dentro do
    // limite de linhas" ainda pode estourar memória na hora de ler/serializar.
    // Usa a classe Query (EventEmitter) em vez do atalho Promise pra poder
    // medir o tamanho linha a linha à medida que chega, e se estourar, manda
    // cancelar a query no servidor (pg_cancel_backend numa conexão separada)
    // — não impede 100% do tráfego já em trânsito, mas evita continuar
    // acumulando linhas em memória e nunca chega a serializar/cachear a
    // resposta inteira.
    const rows: unknown[][] = [];
    let approxBytes = 0;
    let tooLarge = false;
    // processID existe em runtime (PoolClient é sempre um Client de fato),
    // mas não está no tipo PoolClient dos typings do pg.
    const pid = (client as unknown as { processID?: number }).processID;

    const tooLargeError = () => new ApiError(
      413,
      "RESULT_TOO_LARGE",
      `Resultado excede ${Math.round(MAX_RESULT_BYTES / (1024 * 1024))}MB (colunas muito largas). Selecione menos colunas, filtre mais linhas, ou use "stream": true.`,
    );

    let kinds: Record<string, ColumnKind> = {};
    const columns = await new Promise<string[]>((resolve, reject) => {
      // rowMode "array": objeto por linha perderia colunas de mesmo nome (ver columns.ts)
      // (os typings do pg nao declaram rowMode em Query, mas o driver aceita)
      const query = new Query({ text: paged, rowMode: "array" } as never);
      client!.query(query);

      query.on("row", (row: unknown[]) => {
        if (tooLarge) return;
        rows.push(row);
        approxBytes += approxRowBytes(row as unknown as Record<string, unknown>);
        if (approxBytes > MAX_RESULT_BYTES) {
          tooLarge = true;
          if (pid) conn._pool.query("SELECT pg_cancel_backend($1)", [pid]).catch(() => {});
        }
      });

      // pg_cancel_backend faz a query em andamento emitir 'error' (nunca
      // 'end') — quando tooLarge já foi setado, esse erro é esperado (é a
      // própria query cancelada voltando) e vira o 413 correto, em vez de
      // vazar o erro genérico de cancelamento do driver.
      query.on("error", (err: Error) => reject(tooLarge ? tooLargeError() : err));
      query.on("end", (result) => {
        if (tooLarge) return reject(tooLargeError());
        const names = dedupeColumnNames(result.fields.map((f) => f.name));
        kinds = Object.fromEntries(result.fields.map((f, i) => [names[i]!, pgKind(f.dataTypeID)]));
        resolve(names);
      });
    });

    const asObjects = rowsFromArrays(rows.slice(0, effectiveLimit), columns);
    const limitedRows = normalize ? normalizeRows(asObjects, kinds, "pg") : asObjects;
    const legacyCols = legacyFormatColumns(kinds, "pg");

    return {
      columns,
      rows: limitedRows,
      rowCount: limitedRows.length,
      truncated: rows.length > effectiveLimit,
      ...(normalize || legacyCols.length === 0 ? {} : { legacyFormatColumns: legacyCols }),
      executionTimeMs: Date.now() - started,
    };
  } finally {
    await endTx(client);
    client?.release();
  }
  });
}

/** Streaming NDJSON sem limite de linhas — executa query completa e emite linha a linha. */
export async function executeReadOnlyPgStream(
  conn: PgStorageConnection,
  sql: string,
  timeout = 60,
  schemas: string[] = [],
  normalize = false,
  role: string | null = null,
): Promise<ReadableStream<Uint8Array>> {
  const validated = validateReadOnlySql(sql);
  if (!validated.safe) throw new ApiError(400, "UNSAFE_SQL", validated.reason);

  const { sql: translated, topLimit } = await contractTranslate(validated.statement, "postgres", "storage-pg-stream", "regex");
  let statement = translated;
  if (schemas.length > 0) {
    statement = await qualifyTablesForPg(conn, statement, schemas);
  }
  // TOP N do usuario vale tambem no stream (antes era descartado e devolvia tudo)
  const contractMode = await getContractMode();
  if (topLimit !== null && (contractMode === "fallback" || contractMode === "strict")) statement = `${statement} LIMIT ${topLimit}`;

  const timeoutMs = Math.min(Math.max(timeout, 1), 300) * 1000;
  const encoder = new TextEncoder();
  const started = Date.now();

  // Se o cliente HTTP desconecta no meio do stream, o runtime chama cancel()
  // abaixo e o controller já fica fechado/inválido — sem essa guarda,
  // controller.enqueue()/close() joga "Invalid state: Controller is already
  // closed" de dentro do catch/finally, o que é uma exceção não tratada
  // (nada re-captura um throw dentro de catch/finally aqui) e vira
  // uncaughtException, derrubando o processo Node inteiro.
  let closed = false;

  // Executa a query completa e emite as linhas em stream
  return new ReadableStream<Uint8Array>({
    async start(controller) {
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

      let client: PoolClient | null = null;
      try {
        client = await conn._pool.connect();
        await beginReadOnly(client, { timeoutMs, role, schemas });
        const result = await client.query({ text: statement, rowMode: "array" });
        const columns = dedupeColumnNames(result.fields.map((f) => f.name));
        const streamKinds: Record<string, ColumnKind> = normalize
          ? Object.fromEntries(result.fields.map((f, i) => [columns[i]!, pgKind(f.dataTypeID)]))
          : {};
        safeEnqueue(encoder.encode(JSON.stringify({ __columns__: columns }) + "\n"));
        let rowCount = 0;
        for (const arr of result.rows as unknown[][]) {
          if (closed) break; // cliente desconectou — não vale a pena continuar serializando
          const row = rowsFromArrays([arr], columns)[0]!;
          if (normalize) normalizeRows([row], streamKinds, "pg");
          safeEnqueue(encoder.encode(JSON.stringify(row) + "\n"));
          rowCount++;
        }
        safeEnqueue(encoder.encode(JSON.stringify({ __done__: true, rowCount, executionTimeMs: Date.now() - started }) + "\n"));
      } catch (err) {
        const msg = publicQueryErrorMessage(err instanceof Error ? err.message : String(err));
        safeEnqueue(encoder.encode(JSON.stringify({ __error__: true, message: msg, ...(isQueryTimeout(err) ? { code: "QUERY_TIMEOUT" } : {}) }) + "\n"));
      } finally {
        await endTx(client);
        client?.release();
        safeClose();
      }
    },
    cancel() {
      closed = true;
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
