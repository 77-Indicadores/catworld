"use client";
import { useRef, useState } from "react";
import { Braces, Cable, ChevronRight, Database, DatabaseZap, Download, Play, Table2 } from "lucide-react";

type Table = {
  id: string;
  name: string;
  sqlName: string;
  source: { id: string; mode: string; sourceSchema?: string | null; sourceTable?: string | null; connection?: { name: string } } | null;
  columns: { sqlName: string }[];
};
type Dataset = { id: string; name: string; schemaName: string; tables: Table[] };
type Result = { columns: string[]; rows: Record<string, unknown>[]; executionTimeMs: number; truncated: boolean };

export function QueryPanel({ datasets }: { datasets: Dataset[] }) {
  const [sql, setSql] = useState("SELECT TOP 100 *\nFROM ");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<string | null>(datasets[0]?.id ?? null);
  const [liveSourceId, setLiveSourceId] = useState("");
  const [executionHint, setExecutionHint] = useState("Catworld");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function setQueryForTable(dataset: Dataset, table: Table) {
    const isLive = table.source?.mode === "live";
    setLiveSourceId(isLive ? table.source!.id : "");
    setExecutionHint(isLive ? `${table.name} via ${table.source?.connection?.name ?? "Postgres"}` : "Catworld");
    setResult(null);
    const next = isLive
      ? `SELECT *\nFROM ${table.source?.sourceTable ?? table.name}`
      : `SELECT TOP 100 *\nFROM [${dataset.schemaName}].[${table.sqlName}]`;
    setSql(next);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function insertAtCursor(text: string) {
    const el = textareaRef.current;
    if (!el) { setSql((s) => s + text); return; }
    const start = el.selectionStart ?? sql.length, end = el.selectionEnd ?? sql.length;
    const next = sql.slice(0, start) + text + sql.slice(end);
    setSql(next);
    requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = start + text.length; });
  }

  async function download(format: "csv" | "xlsx") {
    if (liveSourceId && result) {
      let blob: Blob;
      if (format === "csv") {
        const csv = [result.columns.map(csvField).join(","), ...result.rows.map(row => result.columns.map(c => csvField(row[c])).join(","))].join("\r\n");
        blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
      } else {
        const ExcelJS = await import("exceljs");
        const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet("Resultado");
        sheet.addRow(result.columns);
        for (const row of result.rows) sheet.addRow(result.columns.map(c => row[c] as string | number | boolean | Date | null));
        sheet.getRow(1).font = { bold: true };
        blob = new Blob([await workbook.xlsx.writeBuffer()], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
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

  async function execute() {
    setRunning(true); setError("");
    try {
      const response = await fetch(liveSourceId ? `/api/v1/dataset-sources/${liveSourceId}/query` : "/api/v1/queries", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql, limit: 10000, timeout: 30 }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "Falha na consulta");
      setResult(body.data);
    } catch (e) { setError(e instanceof Error ? e.message : "Falha na consulta"); }
    finally { setRunning(false); }
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[260px_1fr]">
      <div className="rounded-box border border-base-300 bg-base-100">
        <div className="border-b border-base-300 px-4 py-3 text-sm font-medium">Tabelas do projeto</div>
        <div className="max-h-[60vh] overflow-y-auto p-2">
          {datasets.map((d) => (
            <div key={d.id}>
              <button onClick={() => setExpanded(expanded === d.id ? null : d.id)} className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-base-200"><ChevronRight size={13} className={`transition-transform ${expanded === d.id ? "rotate-90" : ""}`} /><Database size={13} className="text-primary" />{d.name}</button>
              {expanded === d.id && <div className="ml-5 space-y-0.5 border-l border-base-300 pl-2">{d.tables.map((t) => {
                const isLive = t.source?.mode === "live";
                const isExtract = t.source?.mode === "extract";
                return <button key={t.id} onClick={() => setQueryForTable(d, t)} onDoubleClick={() => insertAtCursor(isLive ? (t.source?.sourceTable ?? t.name) : `[${d.schemaName}].[${t.sqlName}]`)} className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-base-content/70 hover:bg-base-200" title={isLive ? "Tabela consultada direto na origem" : "Tabela consultada no Catworld"}>{isLive ? <Cable size={13} /> : isExtract ? <DatabaseZap size={13} /> : <Table2 size={13} />}<span className="truncate">{t.name}</span></button>;
              })}</div>}
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-5">
        <div className="rounded-box border border-base-300 bg-base-100">
          <div className="border-b border-base-300 px-4 py-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div><span className="flex items-center gap-2 text-sm font-medium"><Braces size={15} />Consulta</span></div>
              <div className="flex flex-wrap items-center gap-2"><span className="badge badge-outline">{executionHint}</span><button onClick={execute} disabled={running} className="btn btn-primary btn-sm"><Play size={14} />{running ? "Executando..." : "Executar"}</button></div>
            </div>
          </div>
          <label className="sr-only" htmlFor="query-sql-editor">Editor SQL</label>
          <textarea id="query-sql-editor" ref={textareaRef} value={sql} onChange={(e) => setSql(e.target.value)} className="textarea h-56 w-full resize-none rounded-none border-0 bg-neutral p-5 font-mono text-sm leading-6 text-neutral-content" spellCheck={false} />
          {error && <div className="alert alert-error alert-soft m-4">{error}</div>}
        </div>
        <div className="rounded-box border border-base-300 bg-base-100">
          <div className="flex items-center justify-between border-b border-base-300 px-4 py-3"><span className="text-sm font-medium">Resultado</span>{result && <div className="flex items-center gap-2"><span className="text-xs text-base-content/50">{result.executionTimeMs} ms / {result.rows.length} linhas</span><button onClick={() => download("csv")} className="btn btn-outline btn-xs"><Download size={13} />CSV</button><button onClick={() => download("xlsx")} className="btn btn-outline btn-xs">XLSX</button></div>}</div>
          {!result ? <div className="grid min-h-40 place-items-center text-sm text-base-content/45">Execute a consulta para ver o resultado.</div> : <div className="overflow-x-auto"><table className="table table-zebra data-grid"><thead><tr>{result.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead><tbody>{result.rows.map((r, i) => <tr key={i}>{result.columns.map((c) => <td key={c}>{String(r[c] ?? "NULL")}</td>)}</tr>)}</tbody></table>{result.truncated && <div className="alert alert-warning m-4">Resultado truncado no limite configurado.</div>}</div>}
        </div>
      </div>
    </div>
  );
}

function csvField(value: unknown) {
  const s = String(value ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
