"use client";
import { Time } from "@/components/ui/time";
import { fmtBytes } from "@/lib/fmt";
import { sourceOriginLabel } from "@/lib/workspace/present";
import type { WorkspaceDerived, WorkspaceTable } from "@/lib/workspace/types";

const UPLOAD_MODE: Record<string, string> = {
  replace: "Substituiu os dados",
  append: "Acrescentou linhas",
  upsert: "Atualizou por chave",
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="shrink-0 text-base-content/70">{label}</dt>
      <dd className="min-w-0 break-words text-right font-medium">{children}</dd>
    </div>
  );
}

/** Bloco "Origem": de onde vieram estes dados e como são carregados. */
export function OriginBlock({ table, datasetName, derived }: { table: WorkspaceTable; datasetName: string; derived: WorkspaceDerived | null }) {
  const s = table.source;
  const up = table.lastUpload;

  return (
    <section aria-labelledby="td-origin" className="border-b border-base-300 p-4">
      <h4 id="td-origin" className="mb-2.5 text-[11px] font-semibold text-base-content/70">Origem</h4>
      <dl className="space-y-1.5 text-xs">
        <Row label="Dataset">{datasetName}</Row>
        {s && (
          <>
            <Row label="Tipo">{s.mode === "live" ? "Consulta ao vivo (não copia os dados)" : "Cópia no Catworld"}</Row>
            <Row label="Conexão">{s.connection.name}</Row>
            <Row label="Lê de">
              <span title={s.sourceKind === "query" ? (s.sourceSql ?? undefined) : undefined}>{sourceOriginLabel(s)}</span>
            </Row>
            {s.mode === "extract" && (
              <>
                <Row label="Agenda">{s.refreshCron ? <span className="font-mono">{s.refreshCron} <span className="font-sans text-base-content/70">(UTC)</span></span> : "Manual"}</Row>
                <Row label="Chave">{s.keyColumn ?? <span className="font-normal text-base-content/70">não definida (sem exclusões)</span>}</Row>
                <Row label="Coluna de mudança">{s.deltaColumn ?? <span className="font-normal text-base-content/70">nenhuma (recarrega tudo)</span>}</Row>
              </>
            )}
          </>
        )}
        {!s && derived && (
          <>
            <Row label="Tipo">Tabela derivada (SQL)</Row>
            <Row label="Agenda">{derived.refreshCron ? <span className="font-mono">{derived.refreshCron} <span className="font-sans text-base-content/70">(UTC)</span></span> : "Manual"}</Row>
          </>
        )}
        {!s && !derived && up && (
          <>
            <Row label="Tipo">Arquivo enviado</Row>
            <Row label="Arquivo"><span className="font-mono">{up.filename}</span></Row>
            <Row label="Como entrou">{UPLOAD_MODE[up.mode] ?? up.mode}</Row>
            <Row label="Tamanho do arquivo">{fmtBytes(Number(up.sizeBytes))}</Row>
            <Row label="Enviado em"><Time iso={up.createdAt} relative /></Row>
            {up.createdBy && <Row label="Enviado por">{up.createdBy}</Row>}
          </>
        )}
        {!s && !derived && !up && <Row label="Tipo"><span className="font-normal text-base-content/70">Arquivo enviado (detalhes do envio indisponíveis)</span></Row>}
      </dl>
      {derived && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-base-content/70">SQL da tabela derivada</summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-base-200 p-2 font-mono text-[11px]">{derived.querySql}</pre>
        </details>
      )}
      {s?.sourceKind === "query" && s.sourceSql && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-base-content/70">SQL da fonte</summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-base-200 p-2 font-mono text-[11px]">{s.sourceSql}</pre>
        </details>
      )}
      {s?.reconciliationCron && <p className="mt-2 text-[11px] text-base-content/70">Reconciliação: <span className="font-mono">{s.reconciliationCron}</span> (UTC)</p>}
    </section>
  );
}
