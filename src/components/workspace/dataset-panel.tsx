"use client";
import { useState } from "react";
import { ChevronDown, Code2, Database, DatabaseZap, Plus, Server, Trash2, UploadCloud } from "lucide-react";
import { CopyableId } from "@/components/ui/copyable-id";
import { EditCatalogDialog } from "@/components/management/edit-catalog-dialog";
import { UploadFlow } from "./upload-flow";
import { SourceDialog } from "./source-dialog";
import { PowerBIDialog } from "./powerbi-dialog";
import { useApiAction, useFeedback } from "@/components/ui/feedback";
import type { StorageServerOption, WorkspaceDataset as Dataset } from "@/lib/workspace/types";
import { Time } from "@/components/ui/time";
import { BatchGroupRow } from "./dataset/batch-group-row";
import { DerivedCreateDialog } from "./dataset/derived-dialogs";
import { DerivedRow } from "./dataset/derived-row";
import { SectionHeader, buildGroups } from "./dataset/helpers";
import { SingleSourceRow } from "./dataset/single-source-row";

// ── Storage Server badge (read-only) ──────────────────────────────────────
function StorageServerBadge({ dataset, storageServers }: { dataset: Dataset; storageServers: StorageServerOption[] }) {
  const current = dataset.storageServerId
    ? storageServers.find(s => s.id === dataset.storageServerId)
    : storageServers.find(s => s.isDefault);
  return (
    <span className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-base-content/45" title="Servidor de armazenamento">
      <Server size={10} className="shrink-0" />
      {current?.name ?? "Servidor padrão"}
    </span>
  );
}

// ── Main panel ─────────────────────────────────────────────────────────────
export function DatasetPanel({ dataset, projectSlug, publicOrigin, storageServers, onSelectTable, onChanged }: {
  dataset: Dataset; projectSlug: string; publicOrigin: string; storageServers: StorageServerOption[];
  onSelectTable: (tableId: string) => void; onChanged: () => void;
}) {
  const { confirm: askConfirm } = useFeedback(); const runAction = useApiAction();
  const derivedTargetIds = new Set(dataset.derivedTables.map(dt => dt.targetTable?.id).filter(Boolean));
  const uploadTables = dataset.tables.filter(t => !t.source && !derivedTargetIds.has(t.id));
  const sourceGroups = buildGroups(dataset.tables);
  const [uploadOpen, setUploadOpen] = useState(false);

  async function deleteTable(id: string, name: string) {
    if (!await askConfirm({ title: "Excluir tabela", message: `Excluir a tabela "${name}"? Esta ação não pode ser desfeita.`, confirmLabel: "Excluir", danger: true, typeToConfirm: name })) return;
    if (await runAction(`/api/v1/tables/${id}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmName: name }) }, "Tabela excluída.")) onChanged();
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto text-sm">

      {/* ── Header ── */}
      <div className="border-b border-base-300 px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate font-semibold">{dataset.name}</h2>
            {dataset.description && <p className="mt-0.5 truncate text-xs text-base-content/45">{dataset.description}</p>}
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              <CopyableId value={dataset.id} label="Dataset ID" />
              {storageServers.length > 0 && (
                <StorageServerBadge dataset={dataset} storageServers={storageServers} />
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <PowerBIDialog projectSlug={projectSlug} datasetSlug={dataset.slug} datasetName={dataset.name} publicOrigin={publicOrigin} />
            <EditCatalogDialog kind="dataset" id={dataset.id} name={dataset.name} description={dataset.description} active={dataset.active} />
          </div>
        </div>
      </div>

      {/* ── Fontes ── */}
      <SectionHeader
        label={"Fontes" + (sourceGroups.length ? ` (${sourceGroups.length})` : "")}
        action={<SourceDialog datasetId={dataset.id} onComplete={onChanged} />}
      />

      {sourceGroups.length === 0 ? (
        <div className="flex items-center gap-3 px-5 py-4 text-xs text-base-content/40">
          <DatabaseZap size={14} />
          <span>Nenhuma fonte conectada.</span>
        </div>
      ) : (
        <div className="divide-y divide-base-300">
          {sourceGroups.map(g =>
            g.kind === "batch"
              ? <BatchGroupRow key={g.groupId} {...g} datasetId={dataset.id} onSelectTable={onSelectTable} onChanged={onChanged} />
              : <SingleSourceRow key={g.source.id} {...g} onSelectTable={onSelectTable} onChanged={onChanged} />
          )}
        </div>
      )}

      {/* ── Derivadas ── */}
      <SectionHeader
        label={"Derivadas" + (dataset.derivedTables.length ? ` (${dataset.derivedTables.length})` : "")}
        action={<DerivedCreateDialog datasetId={dataset.id} onComplete={onChanged} />}
      />

      {dataset.derivedTables.length === 0 ? (
        <div className="flex items-center gap-3 px-5 py-4 text-xs text-base-content/40">
          <Code2 size={14} />
          <span>Nenhuma tabela derivada. Crie uma a partir de uma consulta SQL.</span>
        </div>
      ) : (
        <div className="divide-y divide-base-300">
          {dataset.derivedTables.map(dt => (
            <DerivedRow key={dt.id} dt={dt} schemaName={dataset.schemaName} onSelectTable={onSelectTable} onChanged={onChanged} />
          ))}
        </div>
      )}

      {/* ── Tabelas de upload ── */}
      <SectionHeader label={"Tabelas" + (uploadTables.length ? ` (${uploadTables.length})` : "")} />

      {uploadTables.length === 0 ? (
        <div className="flex items-center gap-3 px-5 py-4 text-xs text-base-content/40">
          <Database size={14} />
          <span>Nenhuma tabela de upload. Faça um upload abaixo.</span>
        </div>
      ) : (
        <div className="divide-y divide-base-300">
          {uploadTables.map(t => (
            <div key={t.id} className="flex items-center gap-2 px-5 py-2 hover:bg-base-200">
              <button onClick={() => onSelectTable(t.id)} className="flex flex-1 items-center gap-3 text-left text-xs">
                <Database size={13} className="shrink-0 text-primary" />
                <span className="flex-1 truncate font-medium">{t.name}</span>
                {t.lastDataAt && (
                  <span className="shrink-0 text-base-content/60"><Time iso={t.lastDataAt} /></span>
                )}
              </button>
              <button onClick={() => deleteTable(t.id, t.name)} className="btn btn-ghost btn-xs text-error/50 hover:text-error" title="Excluir tabela">
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── Upload ── */}
      <SectionHeader
        label="Upload"
        action={
          <button onClick={() => setUploadOpen(o => !o)} className="flex items-center gap-1 text-[10px] font-medium text-primary hover:underline">
            {uploadOpen ? <ChevronDown size={12} /> : <Plus size={12} />}
            {uploadOpen ? "Fechar" : "Novo upload"}
          </button>
        }
      />

      {uploadOpen ? (
        <div className="px-5 py-4">
          <UploadFlow datasetId={dataset.id} onComplete={() => { onChanged(); setUploadOpen(false); }} />
        </div>
      ) : (
        <button onClick={() => setUploadOpen(true)} className="flex items-center gap-3 px-5 py-4 text-left text-xs text-base-content/40 hover:bg-base-200 hover:text-base-content/60">
          <UploadCloud size={14} />
          <span>Arraste um CSV, XLSX ou XLS aqui, ou clique para selecionar</span>
        </button>
      )}
    </div>
  );
}
