"use client";
import { useEffect, useState } from "react";
import { Download, FileText } from "lucide-react";
import { apiRequest, errorMessage } from "@/lib/api-client";
import type { WorkspaceTable as Table } from "@/lib/workspace/types";
import { formatInt, presentCount } from "@/lib/present";
import { ResultGrid } from "./result-grid";

function ExportMenu({ tableId }: { tableId: string }) {
  function downloadUrl(what: "data" | "columns") {
    return `/api/v1/tables/${tableId}/export?what=${what}`;
  }

  return (
    <div className="dropdown dropdown-end">
      <button tabIndex={0} className="btn btn-outline btn-sm gap-1">
        <Download size={14} />
        Exportar
      </button>
      <ul tabIndex={0} className="dropdown-content menu rounded-box z-50 mt-1 w-52 border border-base-300 bg-base-100 p-1 shadow-lg text-sm">
        <li><a href={downloadUrl("data")}><FileText size={14} />Dados — CSV</a></li>
        <li className="divider my-0.5" />
        <li><a href={downloadUrl("columns")}><FileText size={14} />Colunas — CSV</a></li>
      </ul>
    </div>
  );
}

/** Grade de dados de uma tabela, embutida na aba "table" do workspace (header/ações ficam no MetadataPanel ao lado). */
export function TablePanel({ table }: { table: Table }) {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const sourceId = table.source?.id;
  const sourceModeValue = table.source?.mode;

  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => { if (!cancelled) { setLoading(true); setError(""); } });
    const live = sourceModeValue === "live";
    apiRequest<{ rows?: Record<string, unknown>[] } | Record<string, unknown>[]>(
      live ? `/api/v1/dataset-sources/${sourceId}/query` : `/api/v1/tables/${table.id}/rows?limit=100`,
      live ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ limit: 100 }) } : undefined,
    )
      .then(({ data }) => { if (cancelled) return; setRows(live ? (data as { rows?: Record<string, unknown>[] })?.rows ?? [] : (data as Record<string, unknown>[]) ?? []); })
      .catch((err) => { if (!cancelled) setError(errorMessage(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [table.id, sourceId, sourceModeValue]);

  return (
    <div className="flex h-full flex-col">
      {(error || table.source?.lastError) && <div className="alert alert-error alert-soft m-3 text-xs p-2">{error || table.source?.lastError}</div>}
      <div className="flex items-center justify-end px-3 py-1.5 border-b border-base-300">
        <ExportMenu tableId={table.id} />
      </div>
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex h-40 items-center justify-center"><span className="loading loading-spinner" /></div>
        ) : rows.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-sm text-base-content/65">Nenhuma linha para exibir.</div>
        ) : (
          <ResultGrid
            columns={table.columns.map(c => c.sqlName)}
            rows={rows}
            numericColumns={new Set(table.columns.filter(c => /^(BIGINT|INT|SMALLINT|TINYINT|DECIMAL|NUMERIC|FLOAT|REAL|MONEY)/i.test(c.sqlType)).map(c => c.sqlName))}
            caption={`Dados de ${table.name}`}
          />
        )}
      </div>
      {!loading && rows.length > 0 && (() => {
        const total = table.source?.mode === "live" ? null : presentCount(table.rowCount);
        if (total && BigInt(rows.length) >= total.value) return null;
        return (
          <p role="status" className="shrink-0 border-t border-base-300 px-3 py-1.5 text-xs text-base-content/70">
            {total
              ? `Mostrando as primeiras ${formatInt(rows.length)} de ${total.exact} linhas. Para ver tudo, exporte ou use uma consulta SQL.`
              : `Mostrando as primeiras ${formatInt(rows.length)} linhas (consulta ao vivo).`}
          </p>
        );
      })()}
    </div>
  );
}
