"use client";
import { normalizeOrigin, odataTableUrl, qualifiedSqlName, sdkChangesExample, sinceCurlExample, sqlSelectExample, supportsSince } from "@/lib/present";
import type { WorkspaceDataset, WorkspaceTable } from "@/lib/workspace/types";
import { CopyField } from "./copy-field";

/** Bloco "Como usar": nome SQL com schema, URL OData e o protocolo incremental (`since`). */
export function UsageBlock({ table, dataset, projectSlug, publicOrigin }: { table: WorkspaceTable; dataset: WorkspaceDataset; projectSlug: string; publicOrigin: string }) {
  const origin = normalizeOrigin(publicOrigin);
  const incremental = supportsSince(table.source);

  return (
    <section aria-labelledby="td-usage" className="border-b border-base-300 p-4">
      <h4 id="td-usage" className="mb-2.5 text-[11px] font-semibold text-base-content/70">Como usar</h4>
      <div className="space-y-3">
        <CopyField label="Nome SQL (T-SQL)" value={qualifiedSqlName(dataset.schemaName, table.sqlName)} />
        <CopyField label="Exemplo de consulta" value={sqlSelectExample(dataset.schemaName, table.sqlName)} />
        <CopyField label="URL OData (Power BI)" value={odataTableUrl(origin, projectSlug, dataset.slug, table.sqlName)} />
      </div>
      <details className="mt-3 text-xs">
        <summary className="cursor-pointer font-medium">Ler só o que mudou (incremental)</summary>
        {incremental ? (
          <div className="mt-2 space-y-3">
            <p className="text-base-content/70">
              A API devolve só as linhas alteradas desde a última leitura. Guarde o <code className="font-mono">nextSince</code> de cada resposta e use como <code className="font-mono">since</code> na próxima.
              {table.source?.keyColumn ? "" : " Sem chave definida na fonte, exclusões não são informadas."}
            </p>
            <CopyField label="REST (curl)" value={sinceCurlExample(origin, table.id)} block />
            <CopyField label="SDK Python" value={sdkChangesExample(table.id)} block />
          </div>
        ) : (
          <p className="mt-2 text-base-content/70">
            {table.source?.mode === "live"
              ? "Esta tabela é uma consulta ao vivo: cada leitura vai direto à origem, então não há leitura incremental (since)."
              : "Só tabelas copiadas de uma conexão (extract) têm leitura incremental. Para tabelas de upload, leia a tabela inteira com uma consulta SQL."}
          </p>
        )}
      </details>
    </section>
  );
}
