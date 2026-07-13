"use client";

// Browser-side CSV/XLSX preview using DuckDB-WASM.
// Runs entirely in the browser — no server round-trip, no worker job needed.
// Falls back gracefully (returns null) if DuckDB fails or format is unsupported.

export type PreviewColumn = {
  originalName: string;
  sqlName: string;
  sqlType: string;
  nullable: boolean;
};

export type FilePreviewResult = {
  columns: PreviewColumn[];
  rows: Record<string, unknown>[];
  rowCount: number;
  encoding: string;
  separator: string | null;
  sheetNames: string[];
};

// Map DuckDB logical types to Catworld SQL types
function duckTypeToSqlType(duckType: string, columnName: string): string {
  const upper = duckType.toUpperCase();
  const nameLower = columnName.toLowerCase();

  // Force text for known identifier-like columns (CPF, CNPJ, CEP, etc.)
  if (/(^|[_\s-])(cpf|cnpj|cep|telefone|phone|celular|whats|codigo|cod|sku|id|documento|doc)([_\s-]|$)/i.test(nameLower)) {
    return "NVARCHAR(MAX)";
  }

  if (upper === "BIGINT" || upper === "HUGEINT" || upper === "INTEGER" || upper === "SMALLINT" || upper === "TINYINT" || upper === "UBIGINT" || upper === "UINTEGER") return "BIGINT";
  if (upper.startsWith("DECIMAL") || upper.startsWith("NUMERIC") || upper === "FLOAT" || upper === "DOUBLE" || upper === "REAL") return "DECIMAL(18,4)";
  if (upper === "DATE") return "DATE";
  if (upper === "TIMESTAMP" || upper === "TIMESTAMP WITH TIME ZONE" || upper.startsWith("TIMESTAMP_")) return "DATETIME2";
  if (upper === "TIME") return "TIME";
  return "NVARCHAR(MAX)";
}

// Convert a SQL identifier (same logic as server-side sqlIdentifier)
function toSqlName(header: string, index: number): string {
  const cleaned = header
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/^(\d)/, "_$1")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
    .slice(0, 128);
  return cleaned || `col_${index + 1}`;
}

let _duckdbModule: typeof import("@duckdb/duckdb-wasm") | null = null;

async function getDuckDB() {
  if (!_duckdbModule) {
    _duckdbModule = await import("@duckdb/duckdb-wasm");
  }
  return _duckdbModule;
}

export async function previewFileInBrowser(file: File): Promise<FilePreviewResult | null> {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  // DuckDB-WASM supports CSV; XLSX support requires the spatial extension which is heavy.
  // Only run DuckDB for CSV — fall back to server for XLSX/XLS.
  if (ext !== "csv") return null;

  try {
    const duckdb = await getDuckDB();
    const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
    const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);

    const worker_url = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }),
    );
    const worker = new Worker(worker_url);
    const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
    const db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(worker_url);

    try {
      await db.registerFileHandle(file.name, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
      const conn = await db.connect();

      try {
        // Auto-detect CSV dialect and get schema.
        // null_padding=true matches csv-parse's relax_column_count behavior (short rows padded, not rejected).
        // No ignore_errors — we want the same row count as the server-side csv-parse import.
        const csvOpts = `sample_size=2000, null_padding=true`;
        const descResult = await conn.query(
          `DESCRIBE SELECT * FROM read_csv_auto(${JSON.stringify(file.name)}, ${csvOpts})`,
        );
        const descRows = descResult.toArray().map((r) => r.toJSON() as { column_name: string; column_type: string });

        // Build column mapping
        const usedNames = new Map<string, number>();
        const columns: PreviewColumn[] = descRows.map((row, i) => {
          let sqlName = toSqlName(row.column_name, i);
          const count = (usedNames.get(sqlName) ?? 0) + 1;
          usedNames.set(sqlName, count);
          if (count > 1) sqlName = `${sqlName}_${count}`;
          return {
            originalName: row.column_name,
            sqlName,
            sqlType: duckTypeToSqlType(row.column_type, row.column_name),
            nullable: true,
          };
        });

        if (columns.length === 0) return null;

        // Get sample rows (up to 20) and row count
        const [sampleResult, countResult] = await Promise.all([
          conn.query(
            `SELECT * FROM read_csv_auto(${JSON.stringify(file.name)}, ${csvOpts}) LIMIT 20`,
          ),
          conn.query(
            `SELECT COUNT(*) AS n FROM read_csv_auto(${JSON.stringify(file.name)}, ${csvOpts})`,
          ),
        ]);

        const rawRows = sampleResult.toArray().map((r) => r.toJSON() as Record<string, unknown>);
        // Remap original column names → sqlNames; coerce BigInt → Number (JSON can't serialize BigInt)
        const rows = rawRows.map((raw) => {
          const out: Record<string, unknown> = {};
          descRows.forEach((d, i) => {
            const val = raw[d.column_name] ?? null;
            out[columns[i]!.sqlName] = typeof val === "bigint" ? Number(val) : val;
          });
          return out;
        });

        const rowCount = Number((countResult.toArray()[0]?.toJSON() as { n: bigint } | undefined)?.n ?? 0);

        // Detect separator by reading first 64 KB as text
        const separator = await detectSeparator(file);

        return { columns, rows, rowCount, encoding: "utf8", separator, sheetNames: [] };
      } finally {
        await conn.close();
      }
    } finally {
      await db.terminate();
      worker.terminate();
    }
  } catch (e) {
    console.warn("[duckdb-preview] falhou, usando preview do servidor:", e);
    return null;
  }
}

async function detectSeparator(file: File): Promise<string> {
  try {
    const slice = file.slice(0, 65536);
    const text = await slice.text();
    const candidates = [";", ",", "\t"];
    const lines = text.split(/\r?\n/).slice(0, 10);
    const scores = candidates.map((c) => ({
      c,
      score: lines.reduce((n, l) => n + (l.split(c).length - 1), 0),
    }));
    return scores.sort((a, b) => b.score - a.score)[0]?.c ?? ",";
  } catch {
    return ",";
  }
}
