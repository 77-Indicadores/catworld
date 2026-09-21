/**
 * DuckDB-accelerated CSV parser for file-path sources.
 *
 * 11× faster than csv-parse on real hardware (benchmark: 500K rows, 28 MB CSV).
 * Used as the primary path when source is a local file path with .csv extension.
 * Falls back to csv-parse (via rowsFromFile) on any DuckDB error.
 *
 * NOT used for streams — DuckDB requires a seekable file, not a ReadableStream.
 */
import type { ParsedColumn } from "./parser";
import { getDuckdbMemoryLimit } from "@/server/worker/runtime-limits";

// One DuckDB instance per concurrent import — avoids a singleton bottleneck when
// multiple workers run simultaneously. Each instance gets its own thread pool so
// parallel imports don't serialize on the same DuckDB process.
// memory_limit: teto de seguranca por instancia — sem isso, uma unica instancia
// (ex: parseando um CSV de centenas de MB) pode tentar usar uma fatia grande da
// RAM do host sem limite algum. Vem do perfil do worker (Configuracoes > Worker), padrao 1GB.
async function getInstance(): Promise<import("@duckdb/node-api").DuckDBInstance> {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  return DuckDBInstance.create(":memory:", { threads: "2", memory_limit: getDuckdbMemoryLimit() });
}

export async function* rowsFromCsvDuckDB(
  filePath: string,
  columns: ParsedColumn[],
): AsyncGenerator<Record<string, unknown>> {
  const instance = await getInstance();
  const conn = await instance.connect();

  const safeFilePath = filePath.replace(/\\/g, "/").replace(/'/g, "''");

  // Get actual column names from DuckDB to build originalName → sqlName mapping
  // parallel=false is required when null_padding=true and the file has quoted newlines;
  // without it DuckDB throws "parallel scanner does not support null_padding with quoted newlines".
  // sample_size omitted (default 20480 rows): with all_varchar=true there are no types to infer,
  // so sample_size=-1 (full-file scan) was wasted I/O — especially painful for 100–200 MB CSVs.
  const csvOpts = `null_padding=true, parallel=false, all_varchar=true`;
  const headerResult = await conn.runAndReadAll(
    `SELECT * FROM read_csv_auto('${safeFilePath}', ${csvOpts}) LIMIT 0`,
  );
  const duckHeaders: string[] = [];
  for (let i = 0; i < headerResult.columnCount; i++) {
    duckHeaders.push(headerResult.columnName(i));
  }

  // Build index mapping with duplicate-header support.
  // indexOf() always returns the first match, so a second column named "nome"
  // would wrongly map to position 0. Track consumed positions per name.
  const headerPositions = new Map<string, number[]>();
  for (let i = 0; i < duckHeaders.length; i++) {
    const h = duckHeaders[i]!;
    if (!headerPositions.has(h)) headerPositions.set(h, []);
    headerPositions.get(h)!.push(i);
  }
  const nameConsumed = new Map<string, number>();
  const colIndices: number[] = columns.map((col, fallbackIdx) => {
    const positions = headerPositions.get(col.originalName);
    if (!positions) return fallbackIdx; // empty/renamed header → positional fallback
    const used = nameConsumed.get(col.originalName) ?? 0;
    nameConsumed.set(col.originalName, used + 1);
    return positions[used] ?? fallbackIdx;
  });

  // PRÉ-VOO: conta as linhas com uma leitura que materializa só o escalar (memória mínima) e, ao contrário do stream, LANÇA o erro
  // real do DuckDB. Motivo (reproduzido): em @duckdb/node-api 1.5.x o stream/for-await/fetchChunk/yieldRowsJs TERMINAM em silêncio
  // no primeiro chunk com erro (ex.: uma linha com coluna a mais na linha 60.000 de 100.000 devolvia 59.392 linhas, sem erro) e o
  // import ficava COMPLETED com linhas faltando (visto em produção: 45.056 de 49.022, todo dia). Aqui, se o DuckDB não consegue ler
  // o arquivo INTEIRO, o erro sobe ANTES de qualquer linha ser entregue, e rowsFromFile cai no csv-parse (leniente) sem duplicar.
  const expected = Number((await conn.runAndReadAll(
    `SELECT count(*) FROM read_csv_auto('${safeFilePath}', ${csvOpts})`,
  )).getRows()[0]![0]);

  let yielded = 0;
  try {
    // all_varchar=true: return raw strings, no type casting — same as csv-parse behaviour.
    // Without this, DuckDB converts "10.50" → 10.5 and dates to ISO, breaking downstream logic.
    const reader = await conn.stream(
      `SELECT * FROM read_csv_auto('${safeFilePath}', ${csvOpts})`,
    );

    for await (const chunk of reader) {
      const rows = chunk.getRows() as unknown[][];
      for (const row of rows) {
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < columns.length; i++) {
          const colIdx = colIndices[i];
          const val = colIdx >= 0 ? (row[colIdx] ?? null) : null;
          // Normalize to string (same as csv-parse which returns strings) or null
          obj[columns[i]!.sqlName] = val == null ? null : String(val);
        }
        yield obj;
        yielded++;
      }
    }
    // Trava final: o que foi entregue tem de ser exatamente o que o pré-voo contou. Lançar aqui (com linhas já entregues) NÃO cai
    // no csv-parse — ver rowsFromFile: erro depois da 1ª linha é fatal, para nunca duplicar nem gravar tabela incompleta.
    if (yielded !== expected) {
      throw new Error(`[integrity] DuckDB entregou ${yielded} de ${expected} linhas do CSV (leitura interrompida); import abortado para não gravar dados incompletos`);
    }
  } finally {
    conn.closeSync();
    // Destroy the instance to free memory — each import gets its own instance
    try { instance.closeSync?.(); } catch { /* best-effort */ }
  }
}

/** Detect if DuckDB is available — used to decide fast/slow path at runtime. */
export async function isDuckDBAvailable(): Promise<boolean> {
  try {
    const inst = await getInstance();
    try { inst.closeSync?.(); } catch { /* best-effort */ }
    return true;
  } catch {
    return false;
  }
}
