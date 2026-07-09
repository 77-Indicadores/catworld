"use client";
import { Database, UploadCloud } from "lucide-react";
import { CopyableId } from "@/components/ui/copyable-id";
import { EditCatalogDialog } from "@/components/management/edit-catalog-dialog";
import { UploadFlow } from "./upload-flow";
import { SourceDialog } from "./source-dialog";

type Dataset = { id: string; name: string; description: string | null; active: boolean; tables: { id: string; name: string }[] };

export function DatasetPanel({ dataset, onSelectTable, onChanged }: { dataset: Dataset; onSelectTable: (tableId: string) => void; onChanged: () => void }) {
  return (
    <div className="space-y-5">
      <div className="rounded-box border border-base-300 bg-base-100 p-5">
        <div className="flex items-start justify-between gap-3">
          <div><h2 className="text-lg font-semibold">{dataset.name}</h2><p className="mt-1 text-sm text-base-content/55">{dataset.description}</p></div>
          <EditCatalogDialog kind="dataset" id={dataset.id} name={dataset.name} description={dataset.description} active={dataset.active} />
        </div>
        <div className="mt-3"><CopyableId value={dataset.id} label="Dataset ID" /></div>
      </div>

      {dataset.tables.length > 0 && (
        <div className="rounded-box border border-base-300 bg-base-100">
          <div className="border-b border-base-300 px-5 py-3 text-sm font-medium">Tabelas</div>
          <div className="divide-y divide-base-300">
            {dataset.tables.map((t) => (
              <button key={t.id} onClick={() => onSelectTable(t.id)} className="flex w-full items-center gap-3 px-5 py-3 text-left text-sm hover:bg-base-200">
                <Database size={15} className="text-primary" /><span>{t.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium"><UploadCloud size={15} />Entrada de dados</div>
        <SourceDialog datasetId={dataset.id} onComplete={onChanged} />
      </div>
      <div>
        <UploadFlow datasetId={dataset.id} onComplete={onChanged} />
      </div>
    </div>
  );
}
