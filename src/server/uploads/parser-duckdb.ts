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

// Lazy singleton — one DuckDB instance per process, reused across imports
let _instance: import("@duckdb/node-api").DuckDBInstance | null = null;

async function getInstance(): Promise<import("@duckdb/node-api").DuckDBInstance> {
  if (!_instance) {
    const { DuckDBInstance } = await import("@duckdb/node-api");
    _instance = await DuckDBInstance.create(":memory:", { threads: "2" });
  }
  return _instance;
}

export async function* rowsFromCsvDuckDB(
  filePath: string,
  columns: ParsedColumn[],
): AsyncGenerator<Record<string, unknown>> {
  const instance = await getInstance();
  const conn = await instance.connect();

  const safeFilePath = filePath.replace(/\\/g, "/").replace(/'/g, "''");

  // Get actual column names from DuckDB to build originalName → sqlName mapping
  const headerResult = await conn.runAndReadAll(
    `SELECT * FROM read_csv_auto('${safeFilePath}', sample_size=-1, all_varchar=true) LIMIT 0`,
  );
  const duckHeaders: string[] = [];
  for (let i = 0; i < headerResult.columnCount; i++) {
    duckHeaders.push(headerResult.columnName(i));
  }

  const colIndices: number[] = columns.map((col) => {
    const idx = duckHeaders.indexOf(col.originalName);
    return idx >= 0 ? idx : -1;
  });

  try {
    // all_varchar=true: return raw strings, no type casting — same as csv-parse behaviour.
    // Without this, DuckDB converts "10.50" → 10.5 and dates to ISO, breaking downstream logic.
    const reader = await conn.stream(
      `SELECT * FROM read_csv_auto('${safeFilePath}', sample_size=-1, ignore_errors=true, all_varchar=true)`,
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
      }
    }
  } finally {
    conn.closeSync();
  }
}

/** Detect if DuckDB is available — used to decide fast/slow path at runtime. */
export async function isDuckDBAvailable(): Promise<boolean> {
  try {
    await getInstance();
    return true;
  } catch {
    return false;
  }
}
