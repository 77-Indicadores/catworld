"use client";
import { useMemo, useState } from "react";
import { Cable, ChevronRight, Database, DatabaseZap, FolderOpen, Search, Table2, Terminal } from "lucide-react";
import { useRouter } from "next/navigation";
import { CopyableId } from "@/components/ui/copyable-id";
import { CreateCatalogDialog } from "@/components/management/create-catalog-dialog";
import { EditCatalogDialog } from "@/components/management/edit-catalog-dialog";
import { DatasetPanel } from "./dataset-panel";
import { TablePanel } from "./table-panel";
import { QueryPanel } from "./query-panel";

type Column = { id: string; sqlName: string; originalName: string; sqlType: string; nullable: boolean };
type TableSource = { id: string; name: string; mode: string; sourceKind: string; sourceSchema: string | null; sourceTable: string | null; refreshPolicy: string; active: boolean; lastStatus: string | null; lastRowCount: string | null; lastError: string | null; lastRefreshedAt: string | null; nextRefreshAt: string | null; connection: { id: string; name: string } };
type Table = { id: string; name: string; sqlName: string; rowCount: string; lastDataAt: string | null; source: TableSource | null; columns: Column[] };
type Dataset = { id: string; slug: string; name: string; description: string | null; active: boolean; schemaName: string; tables: Table[] };
type Project = { id: string; slug: string; name: string; description: string | null; active: boolean; datasets: Dataset[] };

type Selection = { kind: "overview" } | { kind: "query" } | { kind: "dataset"; datasetId: string } | { kind: "table"; datasetId: string; tableId: string };

export function ProjectWorkspace({ project, publicOrigin }: { project: Project; publicOrigin: string }) {
  const router = useRouter();
  const [selection, setSelection] = useState<Selection>({ kind: "overview" });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");

  function refresh() { router.refresh(); }
  function toggle(datasetId: string) { setExpanded((prev) => { const next = new Set(prev); if (next.has(datasetId)) next.delete(datasetId); else next.add(datasetId); return next; }); }

  const filteredDatasets = useMemo(() => {
    if (!filter.trim()) return project.datasets;
    const q = filter.toLowerCase();
    return project.datasets.filter((d) => d.name.toLowerCase().includes(q) || d.tables.some((t) => t.name.toLowerCase().includes(q)));
  }, [project.datasets, filter]);

  const activeDataset = selection.kind === "dataset" || selection.kind === "table" ? project.datasets.find((d) => d.id === selection.datasetId) : undefined;
  const activeTable = selection.kind === "table" ? activeDataset?.tables.find((t) => t.id === selection.tableId) : undefined;

  return (
    <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
      <div className="rounded-box border border-base-300 bg-base-100">
        <div className="border-b border-base-300 p-3">
          <label className="input input-sm flex items-center gap-2"><Search size={14} className="text-base-content/45" /><span className="sr-only">Buscar dataset ou tabela</span><input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Buscar dataset ou tabela..." className="grow" /></label>
        </div>
        <div className="p-2">
          <button onClick={() => setSelection({ kind: "query" })} className={`mb-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm ${selection.kind === "query" ? "bg-primary text-primary-content" : "hover:bg-base-200"}`}>
            <Terminal size={15} />Consultar SQL
          </button>
          <div className="my-2 border-t border-base-300" />
          {filteredDatasets.map((d) => (
            <div key={d.id}>
              <div className={`flex items-center gap-1 rounded-lg pr-2 text-sm ${selection.kind === "dataset" && selection.datasetId === d.id ? "bg-primary text-primary-content" : "hover:bg-base-200"}`}>
                <button onClick={() => toggle(d.id)} className="p-2"><ChevronRight size={13} className={`transition-transform ${expanded.has(d.id) ? "rotate-90" : ""}`} /></button>
                <button onClick={() => setSelection({ kind: "dataset", datasetId: d.id })} className="flex flex-1 items-center gap-2 py-2 text-left"><Database size={15} /><span className="flex-1 truncate">{d.name}</span><span className="shrink-0 text-xs text-base-content/40">{d.tables.length}</span></button>
              </div>
              {expanded.has(d.id) && (
                <div className="ml-6 space-y-0.5 border-l border-base-300 pl-2">
                  {d.tables.map((t) => (
                    <button key={t.id} onClick={() => setSelection({ kind: "table", datasetId: d.id, tableId: t.id })} className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs ${selection.kind === "table" && selection.tableId === t.id ? "bg-primary/15 font-medium text-primary" : "text-base-content/70 hover:bg-base-200"}`}>
                      {t.source?.mode === "live" ? <Cable size={13} /> : t.source?.mode === "extract" ? <DatabaseZap size={13} /> : <Table2 size={13} />}{t.name}
                    </button>
                  ))}
                  {d.tables.length === 0 && <p className="px-2 py-1 text-xs text-base-content/40">Sem tabelas</p>}
                </div>
              )}
            </div>
          ))}
          <div className="mt-2 px-1"><CreateCatalogDialog kind="dataset" projectId={project.id} /></div>
        </div>
      </div>

      <div>
        {selection.kind === "overview" && (
          <div className="space-y-4">
            <div className="rounded-box border border-base-300 bg-base-100 p-6">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-2xl font-bold">{project.name}</h2>
                  <p className="mt-1 text-sm text-base-content/55">{project.description ?? <span className="italic">Sem descrição</span>}</p>
                </div>
                <EditCatalogDialog kind="project" id={project.id} name={project.name} description={project.description} active={project.active} />
              </div>
              <div className="mt-4"><CopyableId value={project.id} label="Project ID" /></div>
              <div className="mt-5 grid grid-cols-3 gap-3">
                {(() => { const ds = project.datasets.length, tb = project.datasets.reduce((n,d)=>n+d.tables.length,0), rows = project.datasets.reduce((n,d)=>d.tables.reduce((m,t)=>m+BigInt(t.rowCount),n),0n); return (<>
                  <div className="rounded-xl bg-base-200 p-4"><p className="text-2xl font-bold">{ds}</p><p className="mt-1 text-xs text-base-content/50">{ds===1?"dataset":"datasets"}</p></div>
                  <div className="rounded-xl bg-base-200 p-4"><p className="text-2xl font-bold">{tb}</p><p className="mt-1 text-xs text-base-content/50">{tb===1?"tabela":"tabelas"}</p></div>
                  <div className="rounded-xl bg-base-200 p-4"><p className="text-2xl font-bold">{rows>1_000_000n?`${(Number(rows)/1e6).toFixed(1)}M`:rows>1_000n?`${(Number(rows)/1e3).toFixed(1)}K`:String(rows)}</p><p className="mt-1 text-xs text-base-content/50">linhas totais</p></div>
                </>); })()}
              </div>
            </div>
            {project.datasets.length === 0 ? (
              <div className="grid min-h-40 place-items-center rounded-box border border-dashed border-base-300 p-10 text-center text-base-content/50">
                <FolderOpen className="mx-auto" size={28} />
                <p className="mt-3 text-sm">Nenhum dataset ainda. Adicione um dataset para começar.</p>
              </div>
            ) : (
              <div className="rounded-box border border-base-300 bg-base-100 p-5">
                <h3 className="mb-3 text-sm font-semibold text-base-content/70 uppercase tracking-wide">Datasets</h3>
                <div className="space-y-1">
                  {project.datasets.map(d => (
                    <button key={d.id} onClick={() => setSelection({ kind: "dataset", datasetId: d.id })} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-base-200">
                      <Database size={16} className="shrink-0 text-primary" />
                      <span className="flex-1 text-sm font-medium">{d.name}</span>
                      <span className="text-xs text-base-content/45">{d.tables.length} {d.tables.length===1?"tabela":"tabelas"}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        {selection.kind === "query" && <QueryPanel datasets={project.datasets} />}
        {selection.kind === "dataset" && activeDataset && (
          <DatasetPanel dataset={activeDataset} projectSlug={project.slug} publicOrigin={publicOrigin} onSelectTable={(tableId) => setSelection({ kind: "table", datasetId: activeDataset.id, tableId })} onChanged={refresh} />
        )}
        {selection.kind === "table" && activeDataset && activeTable && (
          <TablePanel datasetId={activeDataset.id} table={activeTable} onChanged={refresh} />
        )}
      </div>
    </div>
  );
}
