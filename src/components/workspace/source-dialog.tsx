"use client";
import { useEffect, useRef, useState } from "react";
import { Cable, DatabaseZap, Play, Plus, RefreshCw, Table2 } from "lucide-react";

type Connection = { id: string; name: string; server: string; databaseName: string };
type SchemaRow = { schema: string };
type TableRow = { schema: string; table: string };
type Column = { originalName: string; sqlName: string; sqlType: string };

export function SourceDialog({ datasetId, onComplete }: { datasetId: string; onComplete: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [schemas, setSchemas] = useState<SchemaRow[]>([]);
  const [schema, setSchema] = useState("");
  const [tables, setTables] = useState<TableRow[]>([]);
  const [table, setTable] = useState("");
  const [columns, setColumns] = useState<Column[]>([]);
  const [sourceKind, setSourceKind] = useState<"table" | "query">("table");
  const [mode, setMode] = useState<"extract" | "live">("extract");
  const [refreshPolicy, setRefreshPolicy] = useState("manual");
  const [name, setName] = useState("");
  const [sourceSql, setSourceSql] = useState("SELECT *\nFROM ");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function open() {
    ref.current?.showModal();
    const response = await fetch("/api/v1/connections");
    const body = await response.json();
    const rows = (body.data ?? []).filter((c: Connection) => c.id);
    setConnections(rows);
    if (rows[0] && !connectionId) setConnectionId(rows[0].id);
  }

  useEffect(() => {
    if (!connectionId) return;
    fetch(`/api/v1/connections/${connectionId}/schemas`).then((r) => r.json()).then((body) => {
      const rows = body.data ?? [];
      setSchemas(rows);
      setSchema(rows[0]?.schema ?? "");
    });
  }, [connectionId]);

  useEffect(() => {
    if (!connectionId || !schema || sourceKind !== "table") return;
    fetch(`/api/v1/connections/${connectionId}/tables?schema=${encodeURIComponent(schema)}`).then((r) => r.json()).then((body) => {
      const rows = body.data ?? [];
      setTables(rows);
      setTable(rows[0]?.table ?? "");
    });
  }, [connectionId, schema, sourceKind]);

  async function preview() {
    if (!connectionId) return;
    setError("");
    const url = sourceKind === "table"
      ? `/api/v1/connections/${connectionId}/columns?schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}`
      : `/api/v1/connections/${connectionId}/columns?sql=${encodeURIComponent(sourceSql)}`;
    const response = await fetch(url);
    const body = await response.json();
    if (!response.ok) { setError(body.error?.message ?? "Falha ao ler colunas"); return; }
    setColumns(body.data ?? []);
  }

  async function create() {
    setLoading(true); setError("");
    try {
      const response = await fetch(`/api/v1/datasets/${datasetId}/sources`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connectionId,
          name: name || (sourceKind === "table" ? table : "consulta_postgres"),
          mode,
          sourceKind,
          sourceSchema: sourceKind === "table" ? schema : null,
          sourceTable: sourceKind === "table" ? table : null,
          sourceSql: sourceKind === "query" ? sourceSql : null,
          refreshPolicy: mode === "live" ? "manual" : refreshPolicy,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "Falha ao criar fonte");
      ref.current?.close();
      onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao criar fonte");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button onClick={open} className="btn btn-outline btn-sm"><Plus size={14} />Adicionar fonte</button>
      <dialog ref={ref} className="modal">
        <div className="modal-box max-w-4xl">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-lg font-bold">Adicionar fonte Postgres</h3>
            <div className="join">
              <button className={`btn join-item btn-sm ${sourceKind === "table" ? "btn-primary" : "btn-outline"}`} onClick={() => setSourceKind("table")}><Table2 size={14} />Tabela</button>
              <button className={`btn join-item btn-sm ${sourceKind === "query" ? "btn-primary" : "btn-outline"}`} onClick={() => setSourceKind("query")}><Play size={14} />Consulta</button>
            </div>
          </div>
          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <select className="select w-full" value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
              {connections.map((c) => <option key={c.id} value={c.id}>{c.name} - {c.databaseName}</option>)}
            </select>
            <input className="input w-full" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome da tabela no dataset" />
            {sourceKind === "table" ? (
              <>
                <select className="select w-full" value={schema} onChange={(e) => setSchema(e.target.value)}>{schemas.map((s) => <option key={s.schema}>{s.schema}</option>)}</select>
                <select className="select w-full" value={table} onChange={(e) => setTable(e.target.value)}>{tables.map((t) => <option key={`${t.schema}.${t.table}`}>{t.table}</option>)}</select>
              </>
            ) : (
              <textarea className="textarea h-44 w-full font-mono text-sm lg:col-span-2" value={sourceSql} onChange={(e) => setSourceSql(e.target.value)} />
            )}
            <div className="join">
              <button className={`btn join-item btn-sm ${mode === "extract" ? "btn-primary" : "btn-outline"}`} onClick={() => setMode("extract")}><DatabaseZap size={14} />Extract</button>
              <button className={`btn join-item btn-sm ${mode === "live" ? "btn-primary" : "btn-outline"}`} onClick={() => setMode("live")}><Cable size={14} />Live</button>
            </div>
            <select disabled={mode === "live"} className="select w-full" value={refreshPolicy} onChange={(e) => setRefreshPolicy(e.target.value)}>
              <option value="manual">Manual</option><option value="hourly">Hourly</option><option value="daily">Daily</option><option value="weekly">Weekly</option>
            </select>
          </div>
          <div className="mt-4 flex justify-between gap-3">
            <button onClick={preview} className="btn btn-outline btn-sm"><RefreshCw size={14} />Prévia de colunas</button>
            <button onClick={create} disabled={loading || !connectionId} className="btn btn-primary btn-sm">{loading ? "Criando..." : "Criar fonte"}</button>
          </div>
          {error && <div className="alert alert-error alert-soft mt-4">{error}</div>}
          {columns.length > 0 && <div className="mt-4 max-h-56 overflow-auto rounded-box border border-base-300"><table className="table table-sm"><thead><tr><th>Coluna</th><th>SQL</th><th>Tipo</th></tr></thead><tbody>{columns.map((c) => <tr key={c.sqlName}><td>{c.originalName}</td><td className="font-mono text-xs">{c.sqlName}</td><td>{c.sqlType}</td></tr>)}</tbody></table></div>}
          <div className="modal-action"><button type="button" onClick={() => ref.current?.close()} className="btn btn-ghost btn-sm">Fechar</button></div>
        </div>
        <form method="dialog" className="modal-backdrop"><button>fechar</button></form>
      </dialog>
    </>
  );
}
