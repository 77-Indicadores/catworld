"use client";
import { useRef, useState } from "react";
import { Download, Play, Table2 } from "lucide-react";
import { apiErrorText, warningsOf } from "@/lib/api-client";
import { useFeedback } from "@/components/ui/feedback";
import { SchemaBrowser } from "./schema-browser";
import { ResultGrid } from "./result-grid";
import { formatInt } from "@/lib/present";
import type { WorkspaceDataset } from "@/lib/workspace/types";

type Result = { columns: string[]; rows: Record<string, unknown>[]; executionTimeMs: number; truncated: boolean };

export function QueryPanel({ datasets, projectId }: { datasets: WorkspaceDataset[]; projectId?: string }) {
  const [sql, setSql] = useState("SELECT TOP 100 *\nFROM ");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const { notify } = useFeedback();
  const [liveSourceId, setLiveSourceId] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [showBrowser, setShowBrowser] = useState(true);

  // Posição do cursor guardada (o textarea sem foco não informa uma posição confiável): padrão = fim do texto.
  const caret = useRef<{ start: number; end: number } | null>(null);
  const rememberCaret = (el: HTMLTextAreaElement) => { caret.current = { start: el.selectionStart, end: el.selectionEnd }; };

  /** Insere no cursor do editor (ou no fim, se ainda não houve cursor), mantendo o foco. */
  function insertAtCursor(text: string) {
    const { start, end } = caret.current ?? { start: sql.length, end: sql.length };
    const needsSpace = start > 0 && !/[\s(,.\[]$/.test(sql.slice(0, start));
    const chunk = (needsSpace ? " " : "") + text;
    const pos = start + chunk.length;
    setSql(sql.slice(0, start) + chunk + sql.slice(end));
    caret.current = { start: pos, end: pos };
    requestAnimationFrame(() => { const el = textareaRef.current; el?.focus(); el?.setSelectionRange(pos, pos); });
  }

  async function execute() {
    setRunning(true); setError(""); setWarnings([]);
    try {
      const response = await fetch(
        liveSourceId ? `/api/v1/dataset-sources/${liveSourceId}/query` : "/api/v1/queries",
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql, limit: 10000, timeout: 30, normalize: true, ...(projectId ? { projectId } : {}) }) }
      );
      const body = await response.json();
      if (!response.ok) throw new Error(apiErrorText(body, "Falha na consulta"));
      setResult(body.data);
      setWarnings(warningsOf(body.meta));
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
    if (!response.ok) {
      notify("error", apiErrorText(await response.json().catch(() => null), "Não foi possível exportar.", response.status));
      return;
    }
    const blob = await response.blob(), url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = `query.${format}`; a.click(); URL.revokeObjectURL(url);
  }

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      {showBrowser && (
        <aside className="max-h-48 shrink-0 border-b border-base-300 md:max-h-none md:w-60 md:border-b-0 md:border-r">
          <SchemaBrowser datasets={datasets} onInsert={insertAtCursor} />
        </aside>
      )}
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">

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
        <button type="button" onClick={() => setShowBrowser((v) => !v)} aria-pressed={showBrowser} className="btn btn-ghost btn-sm gap-1.5"><Table2 size={13} />Tabelas</button>
        {result && (
          <>
            <span className="text-xs text-base-content/65">{result.rows.length} linhas · {result.executionTimeMs} ms</span>
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
          onChange={(e) => { setSql(e.target.value); rememberCaret(e.target); }}
          onSelect={(e) => rememberCaret(e.currentTarget)}
          onBlur={(e) => rememberCaret(e.currentTarget)}
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

      {warnings.length > 0 && (
        <div role="status" className="m-4 space-y-1 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs">
          {warnings.map((w) => <p key={w}>{w}</p>)}
        </div>
      )}

      {/* Results */}
      <div className="min-h-0 flex-1 overflow-auto">
        {!result && !error && (
          <div className="flex h-full items-center justify-center text-sm text-base-content/65 select-none">
            <span className="text-center">
              Pressione Executar ou <kbd className="kbd kbd-xs mx-1">Ctrl+Enter</kbd> para rodar a consulta.
              <span className="mt-1 block text-xs">A linguagem é T-SQL. Use ORDER BY junto com TOP para o resultado vir sempre na mesma ordem.</span>
            </span>
          </div>
        )}
        {result && (
          <ResultGrid columns={result.columns} rows={result.rows} caption="Resultado da consulta" />
        )}
        {result?.truncated && (
          <div className="border-t border-warning/30 bg-warning/5 px-4 py-2 text-xs text-warning">
            Resultado truncado: mostrando as primeiras {formatInt(result.rows.length)} linhas (limite de 10.000 por consulta). Filtre ou use TOP para ver o que precisa.
          </div>
        )}
      </div>
    </div>
    </div>
  );
}

function csvField(value: unknown) {
  const s = String(value ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
