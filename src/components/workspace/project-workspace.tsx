"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Cable, ChevronRight, Database, DatabaseZap, FolderKanban, Search, Table2, Terminal, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CreateCatalogDialog } from "@/components/management/create-catalog-dialog";
import { EditCatalogDialog } from "@/components/management/edit-catalog-dialog";
import { TablePanel } from "./table-panel";
import { QueryPanel } from "./query-panel";
import { DatasetPanel } from "./dataset-panel";
import { MetadataPanel } from "./metadata-panel";
import { ProjectMigrateStorageDialog } from "./project-migrate-storage-dialog";
import { CopyId } from "./copy-id";
import type { StorageServerOption, WorkspaceDataset as Dataset, WorkspaceProject as Project, WorkspaceTable as Table } from "@/lib/workspace/types";
import { FreshnessDot } from "./freshness-dot";
import { tableFreshness } from "@/lib/workspace/present";
import { worstFreshness } from "@/lib/present";

type Tab =
  | { id: string; kind: "dataset"; datasetId: string; label: string }
  | { id: string; kind: "table"; datasetId: string; tableId: string; label: string }
  | { id: string; kind: "query"; label: string };

/** Pior estado entre as tabelas do dataset (para o ponto na árvore). */
function datasetFreshness(d: Dataset) {
  return worstFreshness(d.tables.map(t => tableFreshness(t, d.derivedTables.find(dt => dt.targetTable?.id === t.id) ?? null)));
}

export function ProjectWorkspace({ project, publicOrigin, storageServers }: { project: Project; publicOrigin: string; storageServers: StorageServerOption[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const hasActiveRefresh = useMemo(
    () => project.datasets.some(d =>
      d.tables.some(t => t.source?.mode === "extract" && (t.source.lastStatus === "queued" || t.source.lastStatus === "running")) ||
      d.derivedTables.some(dt => dt.lastStatus === "queued" || dt.lastStatus === "running"),
    ),
    [project.datasets],
  );

  useEffect(() => {
    if (!hasActiveRefresh) return;
    // Aba escondida não precisa atualizar a cada 3 s: retoma quando voltar a ficar visível.
    const id = window.setInterval(() => { if (!document.hidden) router.refresh(); }, 3000);
    return () => window.clearInterval(id);
  }, [hasActiveRefresh, router]);

  // Restaura a aba a partir da URL (?tab=dataset-x|table-x|query) — permite compartilhar link e
  // sobreviver a um refresh do navegador, que antes sempre voltava pro estado vazio.
  const restoredFromUrl = useRef(false);
  useEffect(() => {
    if (restoredFromUrl.current) return;
    restoredFromUrl.current = true;
    const tabParam = searchParams.get("tab");
    if (!tabParam) return;
    if (tabParam === "query") { openQuery(); return; }
    if (tabParam.startsWith("dataset-")) {
      const datasetId = tabParam.slice("dataset-".length);
      const dataset = project.datasets.find(d => d.id === datasetId);
      if (dataset) openDataset(dataset);
      return;
    }
    if (tabParam.startsWith("table-")) {
      const tableId = tabParam.slice("table-".length);
      for (const dataset of project.datasets) {
        const table = dataset.tables.find(t => t.id === tableId);
        if (table) { openTable(dataset, table); return; }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mantém a URL em sincronia com a aba ativa — dá pra copiar o link e voltar direto pra ela.
  useEffect(() => {
    if (!restoredFromUrl.current) return;
    const params = new URLSearchParams(searchParams.toString());
    if (activeTabId) params.set("tab", activeTabId); else params.delete("tab");
    const next = params.toString();
    if (next === searchParams.toString()) return;
    router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId]);

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
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
    <div className="flex flex-col overflow-hidden" style={{ height: "calc(100vh - 4rem)" }}>

      {/* Breadcrumb: "onde estou" — antes só aparecia (pequeno) no rodapé da sidebar */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-base-300 bg-base-100 px-4 py-2 text-sm">
        <Link href="/projects" className="flex items-center gap-1.5 text-base-content/65 hover:text-primary">
          <FolderKanban size={13} />Projetos
        </Link>
        <ChevronRight size={13} className="text-base-content/65" />
        <span className="font-medium">{project.name}</span>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">

      {/* ── LEFT: Project directory ─────────────────────────────── */}
      <div className="flex w-[240px] shrink-0 flex-col border-r border-base-300 bg-base-100">

        {/* Search */}
        <div className="p-2 border-b border-base-300">
          <label className="input input-xs flex items-center gap-2 bg-base-200">
            <Search size={12} className="text-base-content/65" />
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
                  <ChevronRight size={13} className={"text-base-content/65 transition-transform " + (expanded.has(d.id) ? "rotate-90" : "")} />
                </button>
                <button
                  onClick={() => { openDataset(d); setExpanded(prev => new Set([...prev, d.id])); }}
                  className="flex flex-1 items-center gap-1.5 overflow-hidden py-1.5 pr-2 text-left"
                >
                  <Database size={14} className="shrink-0 text-primary" />
                  <span className={"flex-1 truncate font-medium " + (activeTabId === "dataset-" + d.id ? "" : "text-base-content")}>{d.name}</span>
                  {datasetFreshness(d) && <FreshnessDot freshness={datasetFreshness(d)!} />}
                  <span className="text-xs text-base-content/65">{d.tables.length}</span>
                </button>
              </div>
              {expanded.has(d.id) && (
                <div className="ml-5 border-l border-base-300 pl-2 mb-1">
                  <CopyId label="dataset" id={d.id} className="mb-1" />
                  {d.tables.map(t => (
                    <button
                      key={t.id}
                      onClick={() => openTable(d, t)}
                      className={"flex w-full items-center gap-1.5 rounded py-1.5 pl-2 pr-2 text-left text-xs transition-colors " + (activeTabId === "table-" + t.id ? "bg-primary/10 font-medium text-primary" : "text-base-content/65 hover:bg-base-200")}
                    >
                      {t.source?.mode === "live" ? <Cable size={11} className="shrink-0" /> : t.source?.mode === "extract" ? <DatabaseZap size={11} className="shrink-0" /> : <Table2 size={11} className="shrink-0" />}
                      <span className="flex-1 truncate">{t.name}</span>
                      <FreshnessDot freshness={tableFreshness(t, d.derivedTables.find(dt => dt.targetTable?.id === t.id) ?? null)} />
                      {tabs.some(tab => tab.id === "table-" + t.id) && activeTabId !== "table-" + t.id && <span className="size-1.5 shrink-0 rounded-full bg-primary/40" />}
                    </button>
                  ))}
                  {d.tables.length === 0 && <p className="py-1 pl-2 text-[11px] text-base-content/65">Sem tabelas</p>}
                </div>
              )}
            </div>
          ))}
          {filteredDatasets.length === 0 && (
            <p className="py-4 text-center text-xs text-base-content/65">Nenhum resultado</p>
          )}
        </div>

        {/* Footer: project info + actions */}
        <div className="border-t border-base-300 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-xs font-semibold">{project.name}</span>
            <div className="flex shrink-0 items-center gap-1">
              <CreateCatalogDialog kind="dataset" projectId={project.id} />
              <ProjectMigrateStorageDialog project={project} storageServers={storageServers} onChanged={() => router.refresh()} />
              <EditCatalogDialog kind="project" id={project.id} name={project.name} description={project.description} active={project.active} />
            </div>
          </div>
          {project.description && <p className="mt-0.5 truncate text-[11px] text-base-content/65">{project.description}</p>}
          <CopyId label="project" id={project.id} />
        </div>
      </div>

      {/* ── CENTER+RIGHT: Content area ──────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">

        {/* Tab bar */}
        <div className="flex items-center border-b border-base-300 bg-base-100 overflow-x-auto shrink-0">
          {tabs.length === 0 && (
            <span className="px-4 py-2.5 text-sm text-base-content/65 select-none">
              Selecione uma tabela para começar
            </span>
          )}
          {tabs.map(tab => (
            <div
              key={tab.id}
              onClick={() => setActiveTabId(tab.id)}
              className={"group flex shrink-0 cursor-pointer select-none items-center gap-1.5 border-r border-base-300 px-3 py-2.5 text-sm transition-colors " + (activeTabId === tab.id ? "bg-base-200 font-medium text-base-content" : "text-base-content/65 hover:bg-base-100/60 hover:text-base-content/80")}
            >
              {tab.kind === "query" ? <Terminal size={13} className="shrink-0" /> : tab.kind === "dataset" ? <Database size={13} className="shrink-0 text-primary" /> : <Table2 size={13} className="shrink-0" />}
              <span className="max-w-[140px] truncate">{tab.label}</span>
              <button
                onClick={e => { e.stopPropagation(); closeTab(tab.id); }}
                className="ml-0.5 rounded p-0.5 text-base-content/65 opacity-0 transition-opacity hover:bg-base-300 hover:text-base-content group-hover:opacity-100"
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
              <div className="flex h-full flex-col items-center justify-center text-center text-base-content/65 select-none">
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
                  storageServers={storageServers}
                  onSelectTable={(tableId) => {
                    const table = activeDataset.tables.find(t => t.id === tableId);
                    if (table) openTable(activeDataset, table);
                  }}
                  onChanged={() => router.refresh()}
                />
              </div>
            )}

            {activeTab?.kind === "table" && activeDataset && activeTable && (
              <TablePanel key={activeTable.id} table={activeTable} />
            )}

            {activeTab?.kind === "query" && (
              <QueryPanel datasets={project.datasets} projectId={project.id} />
            )}
          </div>

          {/* Right metadata panel — only for table tabs */}
          {activeTab?.kind === "table" && activeTable && activeDataset && (
            <div className="w-[340px] shrink-0 border-l border-base-300">
              <MetadataPanel
                key={activeTable.id}
                table={activeTable}
                dataset={activeDataset}
                projectSlug={project.slug}
                publicOrigin={publicOrigin}
                onChanged={() => router.refresh()}
              />
            </div>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}
