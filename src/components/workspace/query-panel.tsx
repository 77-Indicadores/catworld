"use client";
import { useRef, useState } from "react";
import { Download, Play } from "lucide-react";

type Dataset = { id: string; name: string; schemaName: string; tables: { id: string; name: string; sqlName: string; source: { id: string; mode: string } | null; columns: { sqlName: string }[] }[] };
type Result = { columns: string[]; rows: Record<string, unknown>[]; executionTimeMs: number; truncated: boolean };

export function QueryPanel({ datasets, projectId }: { datasets: Dataset[]; projectId?: string }) {
  const [sql, setSql] = useState("SELECT TOP 100 *\nFROM ");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [liveSourceId, setLiveSourceId] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Called from workspace directory when user wants to pre-fill a table
  // (datasets prop kept for future use; live source detection)
  void datasets;

  async function execute() {
    setRunning(true); setError("");
    try {
      const response = await fetch(
        liveSourceId ? `/api/v1/dataset-sources/${liveSourceId}/query` : "/api/v1/queries",
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql, limit: 10000, timeout: 30, ...(projectId ? { projectId } : {}) }) }
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "Falha na consulta");
      setResult(body.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha na consulta");
    } finally {
      setRunning(false);
    }
  }

  async function download(format: "csv" | "xlsx") {
    if (liveSourceId && result) {
      let blob: Blob;
      if (format === "csv") {
        const csv = [result.columns.map(csvField).join(","), ...result.rows.map(row => result.columns.map(c => csvField(row[c])).join(","))].join("\r\n");
        blob = new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" });
      } else {
        const ExcelJS = await import("exceljs");
        const wb = new ExcelJS.Workbook(), sh = wb.addWorksheet("Resultado");
        sh.addRow(result.columns);
        for (const row of result.rows) sh.addRow(result.columns.map(c => row[c] as string | number | boolean | Date | null));
        sh.getRow(1).font = { bold: true };
        blob = new Blob([await wb.xlsx.writeBuffer()], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      }
      const url = URL.createObjectURL(blob), a = document.createElement("a");
      a.href = url; a.download = `query.${format}`; a.click(); URL.revokeObjectURL(url);
      return;
    }
    const response = await fetch("/api/v1/queries/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql, format }) });
    if (!response.ok) return;
    const blob = await response.blob(), url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = `query.${format}`; a.click(); URL.revokeObjectURL(url);
  }

  return (
    <div className="flex h-full flex-col">

      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-base-300 bg-base-100 px-4 py-2">
        <button
          onClick={execute}
          disabled={running}
          className="btn btn-primary btn-sm gap-1.5"
        >
          <Play size={13} fill="currentColor" />
          {running ? "Executando…" : "Executar"}
        </button>
        {result && (
          <>
            <span className="text-xs text-base-content/45">{result.rows.length} linhas · {result.executionTimeMs} ms</span>
            <div className="ml-auto flex items-center gap-1">
              <button onClick={() => download("csv")} className="btn btn-ghost btn-xs gap-1"><Download size={12} />CSV</button>
              <button onClick={() => download("xlsx")} className="btn btn-ghost btn-xs gap-1"><Download size={12} />XLSX</button>
            </div>
          </>
        )}
      </div>

      {/* SQL editor */}
      <div className="shrink-0 border-b border-base-300">
        <label className="sr-only" htmlFor="query-sql-editor">Editor SQL</label>
        <textarea
          id="query-sql-editor"
          ref={textareaRef}
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); execute(); } }}
          className="block h-52 w-full resize-none bg-neutral p-4 font-mono text-sm leading-6 text-neutral-content outline-none"
          spellCheck={false}
          placeholder="Digite sua consulta SQL…"
        />
      </div>

      {/* Error */}
      {error && (
        <div className="m-4 rounded-lg border border-error/30 bg-error/5 p-3 font-mono text-xs text-error">
          {error}
        </div>
      )}

      {/* Results */}
      <div className="min-h-0 flex-1 overflow-auto">
        {!result && !error && (
          <div className="flex h-full items-center justify-center text-sm text-base-content/35 select-none">
            Pressione Executar ou <kbd className="kbd kbd-xs mx-1">Ctrl+Enter</kbd> para rodar a consulta
          </div>
        )}
        {result && (
          <table className="table table-zebra data-grid w-full">
            <thead>
              <tr>{result.columns.map(c => <th key={c} className="whitespace-nowrap">{c}</th>)}</tr>
            </thead>
            <tbody>
              {result.rows.map((row, i) => (
                <tr key={i}>
                  {result.columns.map(c => <td key={c} className="whitespace-nowrap">{String(row[c] ?? "NULL")}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {result?.truncated && (
          <div className="border-t border-warning/30 bg-warning/5 px-4 py-2 text-xs text-warning">
            Resultado truncado — exibindo apenas as primeiras {result.rows.length} linhas.
          </div>
        )}
      </div>
    </div>
  );
}

function csvField(value: unknown) {
  const s = String(value ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
