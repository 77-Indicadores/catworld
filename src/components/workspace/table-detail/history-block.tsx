"use client";
import { useState } from "react";
import { StatusBadge } from "@/components/ui/primitives";
import { Time } from "@/components/ui/time";
import { apiRequest, errorMessage } from "@/lib/api-client";
import { fmtDuration } from "@/lib/fmt";
import { JOB_TYPE_LABEL } from "@/lib/labels";
import { fmtBytes, formatInt } from "@/lib/present";
import type { HistoryRun, HistoryVersion, TableHistory } from "@/server/tables/history";

const UPLOAD_MODE: Record<string, string> = { replace: "substituiu", append: "acrescentou", upsert: "atualizou por chave" };

function VersionRow({ v, tableId }: { v: HistoryVersion; tableId: string }) {
  return (
    <li className="flex flex-col gap-0.5 border-b border-base-300 py-2 last:border-0">
      <div className="flex items-baseline justify-between gap-2">
        <Time iso={v.createdAt} className="font-medium" />
        <span className="tabular-nums">{formatInt(v.rowCount)} linhas</span>
      </div>
      <p className="text-base-content/70">
        {v.upload ? <>Upload <span className="font-mono">{v.upload.filename}</span> ({UPLOAD_MODE[v.upload.mode] ?? v.upload.mode}){v.upload.createdBy ? ` · por ${v.upload.createdBy}` : ""}</> : "Sincronização da fonte"}
      </p>
      {v.upload && (v.upload.fileAvailable
        ? <a className="link link-primary w-fit" href={`/api/v1/tables/${tableId}/versions/${v.id}/file`} download>Baixar arquivo original ({fmtBytes(Number(v.upload.sizeBytes))})</a>
        : <p className="text-[11px] text-base-content/70">Arquivo original não guardado (removido pela retenção).</p>)}
    </li>
  );
}

function RunRow({ r }: { r: HistoryRun }) {
  const failed = r.status === "FAILED";
  return (
    <li className="flex flex-col gap-0.5 border-b border-base-300 py-2 last:border-0">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{JOB_TYPE_LABEL[r.kind]?.label ?? r.kind}</span>
        <StatusBadge status={failed ? "error" : "healthy"} label={failed ? "Falhou" : "Concluída"} />
      </div>
      <p className="text-base-content/70">
        <Time iso={r.startedAt} relative />
        {r.durationMs !== null && ` · levou ${fmtDuration(r.durationMs)}`}
        {r.rssMb !== null && ` · ${r.rssMb} MB de memória`}
      </p>
      {failed && r.error && <p className="break-words font-mono text-[11px] text-error">{r.error}</p>}
    </li>
  );
}

/** Bloco "Histórico": versões (cargas que mudaram os dados) e execuções recentes. Carrega ao abrir. */
export function HistoryBlock({ tableId }: { tableId: string }) {
  const [data, setData] = useState<TableHistory | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function load() {
    if (data || loading) return;
    setLoading(true);
    setError("");
    try {
      setData((await apiRequest<TableHistory>(`/api/v1/tables/${tableId}/history`)).data);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section aria-labelledby="td-history" className="border-b border-base-300 p-4">
      <details onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open) void load(); }}>
        <summary id="td-history" className="cursor-pointer text-[11px] font-semibold text-base-content/70">Histórico</summary>
        <div className="mt-3 text-xs" aria-live="polite">
          {loading && <span className="loading loading-spinner loading-xs" aria-label="Carregando histórico" />}
          {error && <div role="alert" className="alert alert-error alert-soft text-xs">{error}</div>}
          {data && (
            <div className="space-y-4">
              <div>
                <h5 className="mb-1 font-semibold">Versões dos dados</h5>
                {data.versions.length === 0
                  ? <p className="text-base-content/70">Nenhuma versão registrada ainda.</p>
                  : <ul>{data.versions.map((v) => <VersionRow key={v.id} v={v} tableId={tableId} />)}</ul>}
              </div>
              <div>
                <h5 className="mb-1 font-semibold">Execuções recentes</h5>
                {data.runs.length === 0
                  ? <p className="text-base-content/70">Nenhuma execução registrada para esta tabela.</p>
                  : <ul>{data.runs.map((r) => <RunRow key={r.id} r={r} />)}</ul>}
                {data.runsNote && <p className="mt-1 text-[11px] text-base-content/70">{data.runsNote}</p>}
              </div>
            </div>
          )}
        </div>
      </details>
    </section>
  );
}
