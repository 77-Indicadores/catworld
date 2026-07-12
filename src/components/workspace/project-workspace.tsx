"use client";
import { useMemo, useState } from "react";
import { Cable, Check, ChevronRight, Copy, Database, DatabaseZap, RefreshCw, Search, Table2, Terminal, Trash2, TriangleAlert, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { StatusBadge } from "@/components/ui/primitives";
import { CreateCatalogDialog } from "@/components/management/create-catalog-dialog";
import { EditCatalogDialog } from "@/components/management/edit-catalog-dialog";
import { TablePanel } from "./table-panel";
import { QueryPanel } from "./query-panel";
import { DatasetPanel } from "./dataset-panel";

type Column = { id: string; sqlName: string; originalName: string; sqlType: string; nullable: boolean };
type TableSource = { id: string; name: string; mode: string; sourceKind: string; sourceGroupId: string | null; sourceSchema: string | null; sourceTable: string | null; sourceSql: string | null; refreshPolicy: string; active: boolean; lastStatus: string | null; lastRowCount: string | null; lastError: string | null; lastRefreshedAt: string | null; nextRefreshAt: string | null; connection: { id: string; name: string } };
type Table = { id: string; name: string; sqlName: string; rowCount: string; lastDataAt: string | null; source: TableSource | null; columns: Column[] };
type Dataset = { id: string; slug: string; name: string; description: string | null; active: boolean; schemaName: string; tables: Table[] };
type Project = { id: string; slug: string; name: string; description: string | null; active: boolean; datasets: Dataset[] };

type Tab =
  | { id: string; kind: "dataset"; datasetId: string; label: string }
  | { id: string; kind: "table"; datasetId: string; tableId: string; label: string }
  | { id: string; kind: "query"; label: string };

function CopyId({ label, id, className }: { label: string; id: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(id).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  }
  return (
    <button
      onClick={copy}
      title={`Copiar ${label} ID`}
      className={"group flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[10px] text-base-content/35 transition-colors hover:bg-base-200 hover:text-base-content/60 " + (className ?? "")}
    >
      {copied ? <Check size={10} className="shrink-0 text-success" /> : <Copy size={10} className="shrink-0 opacity-0 group-hover:opacity-100" />}
      <span className="font-mono truncate">{label}: {id}</span>
    </button>
  );
}

function sourceStatus(status: string | null): "healthy" | "warning" | "error" | "inactive" {
  if (status === "completed" || status === "ready") return "healthy";
  if (status === "failed") return "error";
  if (status === "queued" || status === "running") return "warning";
  return "inactive";
}

function MetadataPanel({ table, dataset, onChanged }: { table: Table; dataset: Dataset; onChanged: () => void }) {
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function refreshSource() {
    if (!table.source) return;
    setRefreshing(true); setError(""); setNotice("");
    const r = await fetch(`/api/v1/dataset-sources/${table.source.id}/refresh`, { method: "POST" });
    setRefreshing(false);
    if (!r.ok) { const body = await r.json().catch(() => ({})); setError(body.error?.message ?? "Falha ao enfileirar"); return; }
    setNotice("Atualização enfileirada."); onChanged();
  }

  const rows = Number(table.rowCount);
  const fmtRows = rows > 1_000_000 ? `${(rows / 1e6).toFixed(1)}M` : rows > 1_000 ? `${(rows / 1e3).toFixed(1)}K` : rows.toLocaleString("pt-BR");

  return (
    <div className="flex h-full flex-col overflow-y-auto text-sm">
      {/* Header */}
      <div className="border-b border-base-300 p-4">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-base-content/40">Sobre esta tabela</p>
        <h3 className="mt-1.5 font-semibold leading-tight">{table.name}</h3>
        <p className="mt-0.5 font-mono text-[11px] text-base-content/40">{table.sqlName}</p>
      </div>

      {/* Stats */}
      <div className="space-y-2.5 border-b border-base-300 p-4 text-xs">
        <div className="flex justify-between gap-2">
          <span className="text-base-content/50">Dataset</span>
          <span className="truncate font-medium text-right">{dataset.name}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-base-content/50">Linhas</span>
          <span className="font-medium font-variant-numeric tabular-nums">{fmtRows}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-base-content/50">Colunas</span>
          <span className="font-medium">{table.columns.length}</span>
        </div>
        {table.lastDataAt && (
          <div className="flex justify-between gap-2">
            <span className="text-base-content/50">Atualizado</span>
            <span className="font-medium text-right">{new Date(table.lastDataAt).toLocaleDateString("pt-BR")}</span>
          </div>
        )}
        {table.source && (
          <div className="flex justify-between gap-2">
            <span className="text-base-content/50">Modo</span>
            <div className="flex items-center gap-1">
              {table.source.mode === "live" ? <Cable size={11} /> : <DatabaseZap size={11} />}
              <span className="font-medium">{table.source.mode === "live" ? "Live" : "Extract"}</span>
            </div>
          </div>
        )}
        {table.source && (
          <div className="flex justify-between gap-2">
            <span className="text-base-content/50">Status</span>
            <StatusBadge status={sourceStatus(table.source.lastStatus)} label={table.source.lastStatus ?? "Pronta"} />
          </div>
        )}
      </div>

      {/* IDs */}
      <div className="border-b border-base-300 px-3 py-2 space-y-0.5">
        <CopyId label="table" id={table.id} />
        <CopyId label="dataset" id={dataset.id} />
      </div>

      {/* Columns */}
      <div className="flex-1 border-b border-base-300 p-4">
        <p className="mb-2.5 text-[10px] font-semibold uppercase tracking-widest text-base-content/40">Colunas ({table.columns.length})</p>
        <div className="space-y-1.5">
          {table.columns.map((col) => (
            <div key={col.id} className="flex items-center gap-2 text-xs">
              <span className="shrink-0 rounded bg-base-200 px-1 py-0.5 font-mono text-[10px] text-base-content/50 leading-tight">
                {col.sqlType.split("(")[0]}
              </span>
              <span className="truncate text-base-content/75">{col.originalName || col.sqlName}</span>
              {col.nullable && <span className="ml-auto shrink-0 text-[10px] text-base-content/30">null</span>}
            </div>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div className="p-4 space-y-2">
        {notice && <div className="alert alert-success alert-soft text-xs p-2">{notice}</div>}
        {error && <div className="alert alert-error alert-soft text-xs p-2">{error}</div>}
        {table.source?.mode === "extract" && (
          <button onClick={refreshSource} disabled={refreshing} className="btn btn-outline btn-sm w-full">
            <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} />
            {refreshing ? "Enfileirando..." : "Atualizar agora"}
          </button>
        )}
        {(!table.source || table.source.mode !== "extract") && table.source && (
          <button disabled className="btn btn-outline btn-sm w-full opacity-40 cursor-not-allowed">
            <RefreshCw size={13} />Fonte live
          </button>
        )}
        <DeleteTableButton tableId={table.id} tableName={table.name} onDeleted={onChanged} />
      </div>
    </div>
  );
}

function DeleteTableButton({ tableId, tableName, onDeleted }: { tableId: string; tableName: string; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(""), [deleting, setDeleting] = useState(false), [error, setError] = useState("");

  async function destroy() {
    setDeleting(true); setError("");
    const r = await fetch(`/api/v1/tables/${tableId}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmName: confirm }) });
    setDeleting(false);
    if (!r.ok) { const b = await r.json(); setError(b.error?.message ?? "Falha ao excluir"); return; }
    onDeleted();
  }

  if (!open) return (
    <button onClick={() => setOpen(true)} className="btn btn-ghost btn-sm w-full text-error/70 hover:text-error">
      <Trash2 size={13} />Excluir tabela
    </button>
  );

  return (
    <div className="rounded-xl border border-error/30 bg-error/5 p-3 space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-error"><TriangleAlert size={12} />Zona de perigo</div>
      <p className="text-[11px] text-base-content/60">Digite <span className="font-mono font-semibold">{tableName}</span> para confirmar:</p>
      <input value={confirm} onChange={e => setConfirm(e.target.value)} className="input input-xs w-full" />
      {error && <p className="text-[11px] text-error">{error}</p>}
      <div className="flex gap-2">
        <button onClick={() => { setOpen(false); setConfirm(""); setError(""); }} className="btn btn-ghost btn-xs flex-1">Cancelar</button>
        <button onClick={destroy} disabled={confirm !== tableName || deleting} className="btn btn-error btn-xs flex-1">{deleting ? "..." : "Excluir"}</button>
      </div>
    </div>
  );
}

export function ProjectWorkspace({ project, publicOrigin }: { project: Project; publicOrigin: string }) {
  const router = useRouter();
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");

  function openDataset(dataset: Dataset) {
    const tabId = `dataset-${dataset.id}`;
    if (tabs.find(t => t.id === tabId)) { setActiveTabId(tabId); return; }
    setTabs(prev => [...prev, { id: tabId, kind: "dataset", datasetId: dataset.id, label: dataset.name }]);
    setActiveTabId(tabId);
  }

  function openTable(dataset: Dataset, table: Table) {
    const tabId = `table-${table.id}`;
    if (tabs.find(t => t.id === tabId)) { setActiveTabId(tabId); return; }
    setTabs(prev => [...prev, { id: tabId, kind: "table", datasetId: dataset.id, tableId: table.id, label: table.name }]);
    setActiveTabId(tabId);
    setExpanded(prev => new Set([...prev, dataset.id]));
  }

  function openQuery() {
    const existing = tabs.find(t => t.kind === "query");
    if (existing) { setActiveTabId(existing.id); return; }
    const tab: Tab = { id: "query", kind: "query", label: "Consultar SQL" };
    setTabs(prev => [...prev, tab]);
    setActiveTabId("query");
  }

  function closeTab(tabId: string) {
    setTabs(prev => {
      const next = prev.filter(t => t.id !== tabId);
      if (activeTabId === tabId) {
        const idx = prev.findIndex(t => t.id === tabId);
        setActiveTabId(next[idx]?.id ?? next[idx - 1]?.id ?? null);
      }
      return next;
    });
  }

  function toggleDataset(id: string) {
    setExpanded(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  }

  const activeTab = tabs.find(t => t.id === activeTabId) ?? null;
  const activeDataset = (activeTab?.kind === "table" || activeTab?.kind === "dataset")
    ? project.datasets.find(d => d.id === activeTab.datasetId) : undefined;
  const activeTable = activeTab?.kind === "table" && activeDataset
    ? activeDataset.tables.find(t => t.id === activeTab.tableId) : undefined;

  const filteredDatasets = useMemo(() => {
    if (!filter.trim()) return project.datasets;
    const q = filter.toLowerCase();
    return project.datasets.filter(d => d.name.toLowerCase().includes(q) || d.tables.some(t => t.name.toLowerCase().includes(q)));
  }, [project.datasets, filter]);

  return (
    <div className="flex overflow-hidden" style={{ height: "calc(100vh - 4rem)" }}>

      {/* ── LEFT: Project directory ─────────────────────────────── */}
      <div className="flex w-[240px] shrink-0 flex-col border-r border-base-300 bg-base-100">

        {/* Search */}
        <div className="p-2 border-b border-base-300">
          <label className="input input-xs flex items-center gap-2 bg-base-200">
            <Search size={12} className="text-base-content/40" />
            <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Buscar tabela..." className="grow" />
          </label>
        </div>

        {/* Query button */}
        <div className="px-2 pt-2">
          <button
            onClick={openQuery}
            className={"flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors " + (activeTab?.kind === "query" ? "bg-primary/10 font-medium text-primary" : "text-base-content/65 hover:bg-base-200")}
          >
            <Terminal size={14} />Consultar SQL
          </button>
        </div>

        <div className="mx-3 my-2 border-t border-base-300" />

        {/* Dataset + table tree */}
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {filteredDatasets.map(d => (
            <div key={d.id}>
              <div className={"flex w-full items-center gap-1 rounded-lg text-sm transition-colors " + (activeTabId === "dataset-" + d.id ? "bg-primary/10 text-primary" : "hover:bg-base-200")}>
                <button onClick={() => toggleDataset(d.id)} className="shrink-0 p-1.5" aria-label="Expandir">
                  <ChevronRight size={13} className={"text-base-content/35 transition-transform " + (expanded.has(d.id) ? "rotate-90" : "")} />
                </button>
                <button
                  onClick={() => { openDataset(d); setExpanded(prev => new Set([...prev, d.id])); }}
                  className="flex flex-1 items-center gap-1.5 overflow-hidden py-1.5 pr-2 text-left"
                >
                  <Database size={14} className="shrink-0 text-primary" />
                  <span className={"flex-1 truncate font-medium " + (activeTabId === "dataset-" + d.id ? "" : "text-base-content")}>{d.name}</span>
                  <span className="text-xs text-base-content/30">{d.tables.length}</span>
                </button>
              </div>
              {expanded.has(d.id) && (
                <div className="ml-5 border-l border-base-300 pl-2 mb-1">
                  <CopyId label="dataset" id={d.id} className="mb-1" />
                  {d.tables.map(t => (
                    <button
                      key={t.id}
                      onClick={() => openTable(d, t)}
                      className={"flex w-full items-center gap-1.5 rounded py-1.5 pl-2 pr-2 text-left text-xs transition-colors " + (activeTabId === "table-" + t.id ? "bg-primary/10 font-medium text-primary" : "text-base-content/60 hover:bg-base-200")}
                    >
                      {t.source?.mode === "live" ? <Cable size={11} className="shrink-0" /> : t.source?.mode === "extract" ? <DatabaseZap size={11} className="shrink-0" /> : <Table2 size={11} className="shrink-0" />}
                      <span className="flex-1 truncate">{t.name}</span>
                      {tabs.some(tab => tab.id === "table-" + t.id) && activeTabId !== "table-" + t.id && <span className="size-1.5 shrink-0 rounded-full bg-primary/40" />}
                    </button>
                  ))}
                  {d.tables.length === 0 && <p className="py-1 pl-2 text-[11px] text-base-content/30">Sem tabelas</p>}
                </div>
              )}
            </div>
          ))}
          {filteredDatasets.length === 0 && (
            <p className="py-4 text-center text-xs text-base-content/35">Nenhum resultado</p>
          )}
        </div>

        {/* Footer: project info + actions */}
        <div className="border-t border-base-300 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-xs font-semibold">{project.name}</span>
            <div className="flex shrink-0 items-center gap-1">
              <CreateCatalogDialog kind="dataset" projectId={project.id} />
              <EditCatalogDialog kind="project" id={project.id} name={project.name} description={project.description} active={project.active} />
            </div>
          </div>
          {project.description && <p className="mt-0.5 truncate text-[11px] text-base-content/40">{project.description}</p>}
          <CopyId label="project" id={project.id} />
        </div>
      </div>

      {/* ── CENTER+RIGHT: Content area ──────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">

        {/* Tab bar */}
        <div className="flex items-center border-b border-base-300 bg-base-100 overflow-x-auto shrink-0">
          {tabs.length === 0 && (
            <span className="px-4 py-2.5 text-sm text-base-content/35 select-none">
              Selecione uma tabela para começar
            </span>
          )}
          {tabs.map(tab => (
            <div
              key={tab.id}
              onClick={() => setActiveTabId(tab.id)}
              className={"group flex shrink-0 cursor-pointer select-none items-center gap-1.5 border-r border-base-300 px-3 py-2.5 text-sm transition-colors " + (activeTabId === tab.id ? "bg-base-200 font-medium text-base-content" : "text-base-content/50 hover:bg-base-100/60 hover:text-base-content/80")}
            >
              {tab.kind === "query" ? <Terminal size={13} className="shrink-0" /> : tab.kind === "dataset" ? <Database size={13} className="shrink-0 text-primary" /> : <Table2 size={13} className="shrink-0" />}
              <span className="max-w-[140px] truncate">{tab.label}</span>
              <button
                onClick={e => { e.stopPropagation(); closeTab(tab.id); }}
                className="ml-0.5 rounded p-0.5 text-base-content/25 opacity-0 transition-opacity hover:bg-base-300 hover:text-base-content group-hover:opacity-100"
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>

        {/* Content row: main + metadata panel */}
        <div className="flex min-h-0 flex-1">

          {/* Main content */}
          <div className="min-w-0 flex-1 overflow-auto">
            {!activeTab && (
              <div className="flex h-full flex-col items-center justify-center text-center text-base-content/30 select-none">
                <Database size={36} className="mb-3 opacity-25" />
                <p className="text-sm">Selecione um dataset ou tabela no diretório</p>
                <p className="mt-1 text-xs">ou use Consultar SQL para escrever uma query</p>
              </div>
            )}

            {activeTab?.kind === "dataset" && activeDataset && (
              <div className="p-6 overflow-auto h-full">
                <DatasetPanel
                  key={activeDataset.id}
                  dataset={activeDataset}
                  projectSlug={project.slug}
                  publicOrigin={publicOrigin}
                  onSelectTable={(tableId) => {
                    const table = activeDataset.tables.find(t => t.id === tableId);
                    if (table) openTable(activeDataset, table);
                  }}
                  onChanged={() => router.refresh()}
                />
              </div>
            )}

            {activeTab?.kind === "table" && activeDataset && activeTable && (
              <TablePanel
                key={activeTable.id}
                datasetId={activeDataset.id}
                table={activeTable}
                onChanged={() => router.refresh()}
                compact
              />
            )}

            {activeTab?.kind === "query" && (
              <QueryPanel datasets={project.datasets} projectId={project.id} />
            )}
          </div>

          {/* Right metadata panel — only for table tabs */}
          {activeTab?.kind === "table" && activeTable && activeDataset && (
            <div className="w-[260px] shrink-0 border-l border-base-300">
              <MetadataPanel
                key={activeTable.id}
                table={activeTable}
                dataset={activeDataset}
                onChanged={() => router.refresh()}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
