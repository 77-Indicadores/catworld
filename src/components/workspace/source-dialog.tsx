"use client";
import { useEffect, useRef, useState } from "react";
import { Cable, CheckCircle2, DatabaseZap, Play, Plus, RefreshCw, Search, Table2 } from "lucide-react";

type Connection = { id: string; name: string; provider: string; server: string; databaseName: string };
type SchemaRow = { schema: string };
type TableRow = { schema: string; table: string };
type Column = { originalName: string; sqlName: string; sqlType: string };
type Step = "origin" | "mode" | "preview";

function Field({ label, hint, children, wide = false }: { label: string; hint?: string; children: React.ReactNode; wide?: boolean }) {
  return <label className={`form-control w-full ${wide ? "lg:col-span-2" : ""}`}><span className="label-text font-medium">{label}</span><div className="mt-1">{children}</div>{hint && <span className="label-text-alt mt-1 text-base-content/55">{hint}</span>}</label>;
}

function StepItem({ active, done, label }: { active: boolean; done: boolean; label: string }) {
  return <span className={`flex items-center gap-2 rounded-full px-3 py-1 text-xs ${active ? "bg-primary text-primary-content" : done ? "bg-success/10 text-success" : "bg-base-200 text-base-content/60"}`}>{done ? <CheckCircle2 size={13} /> : null}{label}</span>;
}

export function SourceDialog({ datasetId, onComplete }: { datasetId: string; onComplete: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState<Step>("origin");
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [schemas, setSchemas] = useState<SchemaRow[]>([]);
  const [schema, setSchema] = useState("");
  const [tables, setTables] = useState<TableRow[]>([]);
  const [selectedTables, setSelectedTables] = useState<string[]>([]);
  const [columns, setColumns] = useState<Column[]>([]);
  const [queryTestedSql, setQueryTestedSql] = useState("");
  const [queryStatus, setQueryStatus] = useState<"idle" | "ok" | "error">("idle");
  const [sourceKind, setSourceKind] = useState<"table" | "query">("table");
  const [mode, setMode] = useState<"extract" | "live">("extract");
  const [refreshPolicy, setRefreshPolicy] = useState("manual");
  const [queryName, setQueryName] = useState("");
  const [sourceSql, setSourceSql] = useState("SELECT *\nFROM ");
  const [tableSearch, setTableSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingMeta, setLoadingMeta] = useState(false);
  const [error, setError] = useState("");

  async function open() {
    setStep("origin"); setError(""); setColumns([]); setSelectedTables([]); setQueryStatus("idle"); setQueryTestedSql(""); setTableSearch("");
    ref.current?.showModal();
    setLoadingMeta(true);
    const response = await fetch("/api/v1/connections");
    const body = await response.json();
    const rows = (body.data ?? []).filter((c: Connection) => c.id);
    setConnections(rows);
    if (rows[0] && !connectionId) setConnectionId(rows[0].id);
    setLoadingMeta(false);
  }

  useEffect(() => {
    if (!connectionId) return;
    Promise.resolve().then(() => setLoadingMeta(true));
    fetch(`/api/v1/connections/${connectionId}/schemas`).then((r) => r.json()).then((body) => {
      const rows = body.data ?? [];
      setSchemas(rows);
      setSchema(rows[0]?.schema ?? "");
      setSelectedTables([]);
    }).finally(() => setLoadingMeta(false));
  }, [connectionId]);

  useEffect(() => {
    if (!connectionId || !schema || sourceKind !== "table") return;
    Promise.resolve().then(() => setLoadingMeta(true));
    fetch(`/api/v1/connections/${connectionId}/tables?schema=${encodeURIComponent(schema)}`).then((r) => r.json()).then((body) => {
      setTables(body.data ?? []);
      setSelectedTables([]);
    }).finally(() => setLoadingMeta(false));
  }, [connectionId, schema, sourceKind]);

  function toggleTable(table: string) {
    setSelectedTables((prev) => prev.includes(table) ? prev.filter((t) => t !== table) : [...prev, table]);
  }

  async function preview() {
    if (!connectionId) return;
    if (sourceKind === "table") { setColumns([]); setStep("preview"); return; }
    if (queryStatus !== "ok" || queryTestedSql !== sourceSql) {
      const ok = await testQuery();
      if (!ok) return;
    }
    setStep("preview");
  }

  async function testQuery() {
    if (!connectionId || sourceKind !== "query") return false;
    setLoading(true); setError(""); setQueryStatus("idle");
    const response = await fetch(`/api/v1/connections/${connectionId}/columns?sql=${encodeURIComponent(sourceSql)}`);
    const body = await response.json();
    setLoading(false);
    if (!response.ok) { setColumns([]); setQueryStatus("error"); setError(body.error?.message ?? "Falha ao testar consulta"); return false; }
    setColumns(body.data ?? []);
    setQueryTestedSql(sourceSql);
    setQueryStatus("ok");
    return true;
  }

  async function create() {
    setLoading(true); setError("");
    try {
      const response = await fetch(`/api/v1/datasets/${datasetId}/sources`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sourceKind === "table" ? {
          connectionId,
          mode,
          sourceKind,
          sourceSchema: schema,
          sourceTables: selectedTables,
          refreshPolicy: mode === "live" ? "manual" : refreshPolicy,
        } : {
          connectionId,
          name: queryName,
          mode,
          sourceKind,
          sourceSql,
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

  const activeConnection = connections.find((c) => c.id === connectionId);
  const providerLabel = activeConnection?.provider === "mssql" ? "SQL Server" : "Postgres";
  const queryIsReady = queryName.trim() && sourceSql.trim() && queryStatus === "ok" && queryTestedSql === sourceSql;
  const canChooseOrigin = connectionId && (sourceKind === "table" ? selectedTables.length > 0 : queryIsReady);
  const modeLabel = mode === "extract" ? "Copiar para o Catworld" : `Consultar direto no ${providerLabel}`;

  return (
    <>
      <button onClick={open} className="btn btn-outline btn-sm"><Plus size={14} />Adicionar fonte</button>
      <dialog ref={ref} className="modal">
        <div className="modal-box max-w-4xl">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div><h3 className="text-lg font-bold">Adicionar fonte de dados</h3><p className="mt-1 text-sm text-base-content/60">Escolha uma ou mais tabelas, ou crie uma fonte a partir de uma consulta.</p></div>
            <div className="flex flex-wrap gap-2"><StepItem label="Origem" active={step === "origin"} done={step !== "origin"} /><StepItem label="Uso" active={step === "mode"} done={step === "preview"} /><StepItem label="Revisao" active={step === "preview"} done={false} /></div>
          </div>

          {loadingMeta && <div className="alert alert-info alert-soft mt-4"><span className="loading loading-spinner loading-sm" />Carregando metadados da conexao...</div>}
          {connections.length === 0 && !loadingMeta && <div className="alert alert-warning alert-soft mt-4">Crie uma conexao antes de adicionar fontes ao dataset.</div>}
          {error && <div className="alert alert-error alert-soft mt-4">{error}</div>}

          {step === "origin" && (
            <div className="mt-5 space-y-5">
              <div className="join">
                <button type="button" className={`btn join-item btn-sm ${sourceKind === "table" ? "btn-primary" : "btn-outline"}`} onClick={() => setSourceKind("table")}><Table2 size={14} />Selecionar tabelas</button>
                <button type="button" className={`btn join-item btn-sm ${sourceKind === "query" ? "btn-primary" : "btn-outline"}`} onClick={() => setSourceKind("query")}><Play size={14} />Usar consulta</button>
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                <Field label="Conexao"><select className="select w-full" value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>{connections.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.provider === "mssql" ? "SQL Server" : "Postgres"}) - {c.databaseName}</option>)}</select></Field>
                {sourceKind === "table" ? (
                  <>
                    <Field label="Schema"><select className="select w-full" value={schema} onChange={(e) => setSchema(e.target.value)}>{schemas.map((s) => <option key={s.schema}>{s.schema}</option>)}</select></Field>
                    <div className="lg:col-span-2">
                      {(() => {
                        const filtered = tables.filter(t => t.table.toLowerCase().includes(tableSearch.toLowerCase()));
                        const allFilteredSelected = filtered.length > 0 && filtered.every(t => selectedTables.includes(t.table));
                        function toggleAll() {
                          if (allFilteredSelected) setSelectedTables(prev => prev.filter(n => !filtered.some(t => t.table === n)));
                          else setSelectedTables(prev => [...new Set([...prev, ...filtered.map(t => t.table)])]);
                        }
                        return (
                          <>
                            <div className="mb-2 flex items-center gap-2">
                              <label className="input input-sm flex flex-1 items-center gap-2 border border-base-300">
                                <Search size={13} className="text-base-content/40" />
                                <input type="text" className="grow" placeholder="Pesquisar tabela/view..." value={tableSearch} onChange={e => setTableSearch(e.target.value)} />
                              </label>
                              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-base-content/60 select-none whitespace-nowrap">
                                <input type="checkbox" className="checkbox checkbox-xs" checked={allFilteredSelected} onChange={toggleAll} disabled={filtered.length === 0} />
                                Selecionar todas
                              </label>
                              <span className="text-xs text-base-content/40 whitespace-nowrap">{selectedTables.length} sel.</span>
                            </div>
                            <div className="max-h-64 overflow-auto rounded-box border border-base-300">
                              {tables.length === 0
                                ? <div className="p-4 text-sm text-base-content/50">Nenhuma tabela ou view encontrada neste schema.</div>
                                : filtered.length === 0
                                  ? <div className="p-4 text-sm text-base-content/50">Nenhum resultado para "{tableSearch}".</div>
                                  : filtered.map(t => (
                                    <label key={t.schema + "." + t.table} className="flex cursor-pointer items-center gap-3 border-b border-base-300 px-4 py-2 text-sm last:border-b-0 hover:bg-base-200">
                                      <input type="checkbox" className="checkbox checkbox-sm" checked={selectedTables.includes(t.table)} onChange={() => toggleTable(t.table)} />
                                      <span className="font-mono text-xs">{t.table}</span>
                                    </label>
                                  ))
                              }
                            </div>
                          </>
                        );
                      })()}
                    </div>
                  </>
                ) : (
                  <>
                    <Field label="Nome da tabela no Catworld" hint="Obrigatorio para fontes criadas por consulta."><input className="input w-full" value={queryName} onChange={(e) => setQueryName(e.target.value)} /></Field>
                    <Field label="Consulta SQL" hint={`Somente SELECT ou WITH. A consulta roda no ${providerLabel} da conexao escolhida.`} wide><textarea className="textarea h-44 w-full font-mono text-sm" value={sourceSql} onChange={(e) => { setSourceSql(e.target.value); setQueryStatus("idle"); }} /></Field>
                    <div className="lg:col-span-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <button type="button" className="btn btn-outline btn-sm" onClick={testQuery} disabled={loading || !connectionId || !sourceSql.trim()}><Play size={14} />{loading ? "Testando..." : "Testar consulta"}</button>
                        {queryStatus === "ok" && <span className="badge badge-success badge-outline">{columns.length} coluna(s) encontrada(s)</span>}
                      </div>
                      {columns.length > 0 && queryStatus === "ok" && <div className="mt-3 max-h-44 overflow-auto rounded-box border border-base-300"><table className="table table-sm"><thead><tr><th>Coluna</th><th>Nome no Catworld</th><th>Tipo</th></tr></thead><tbody>{columns.map((c) => <tr key={c.sqlName}><td>{c.originalName}</td><td className="font-mono text-xs">{c.sqlName}</td><td>{c.sqlType}</td></tr>)}</tbody></table></div>}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {step === "mode" && (
            <div className="mt-5 grid gap-4 lg:grid-cols-2">
              <button type="button" onClick={() => setMode("extract")} className={`rounded-box border p-4 text-left ${mode === "extract" ? "border-primary bg-primary/10" : "border-base-300 bg-base-100"}`}><DatabaseZap className="text-primary" size={22} /><h4 className="mt-3 font-semibold">Copiar para o Catworld</h4><p className="mt-1 text-sm text-base-content/60">Cria tabela(s) fisicas no dataset com o mesmo nome das tabelas selecionadas.</p></button>
              <button type="button" onClick={() => setMode("live")} className={`rounded-box border p-4 text-left ${mode === "live" ? "border-primary bg-primary/10" : "border-base-300 bg-base-100"}`}><Cable className="text-primary" size={22} /><h4 className="mt-3 font-semibold">Consultar direto no {providerLabel}</h4><p className="mt-1 text-sm text-base-content/60">Nao copia dados. Cada visualizacao consulta a origem.</p></button>
              <Field label="Atualizacao" hint={mode === "live" ? "Fontes ao vivo sempre consultam a origem na hora." : "Define quando o Catworld deve copiar os dados novamente."} wide><select disabled={mode === "live"} className="select w-full" value={refreshPolicy} onChange={(e) => setRefreshPolicy(e.target.value)}><option value="manual">Manual</option><option value="hourly">A cada hora</option><option value="daily">Diaria</option><option value="weekly">Semanal</option></select></Field>
            </div>
          )}

          {step === "preview" && (
            <div className="mt-5 space-y-4">
              <div className="rounded-box border border-base-300 bg-base-200/40 p-4 text-sm"><strong>{modeLabel}</strong><span className="ml-2 text-base-content/60">{sourceKind === "table" ? `${selectedTables.length} tabela(s) de ${schema}` : queryName}</span></div>
              {sourceKind === "table" ? <div className="max-h-72 overflow-auto rounded-box border border-base-300"><table className="table table-sm"><thead><tr><th>Tabela {providerLabel}</th><th>Nome no Catworld</th></tr></thead><tbody>{selectedTables.map((t) => <tr key={t}><td className="font-mono text-xs">{schema}.{t}</td><td>{t}</td></tr>)}</tbody></table></div> : columns.length > 0 ? <div className="max-h-72 overflow-auto rounded-box border border-base-300"><table className="table table-sm"><thead><tr><th>Coluna na origem</th><th>Nome no Catworld</th><th>Tipo</th></tr></thead><tbody>{columns.map((c) => <tr key={c.sqlName}><td>{c.originalName}</td><td className="font-mono text-xs">{c.sqlName}</td><td>{c.sqlType}</td></tr>)}</tbody></table></div> : <div className="alert alert-warning alert-soft">Nenhuma coluna carregada. Volte e gere a previa novamente.</div>}
            </div>
          )}

          <div className="modal-action justify-between">
            <div>{step !== "origin" && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setStep(step === "preview" ? "mode" : "origin")}>Voltar</button>}</div>
            <div className="flex gap-2"><button type="button" onClick={() => ref.current?.close()} className="btn btn-ghost btn-sm">Fechar</button>{step === "origin" && <button type="button" disabled={!canChooseOrigin} className="btn btn-primary btn-sm" onClick={() => setStep("mode")}>Continuar</button>}{step === "mode" && <button type="button" disabled={loading} className="btn btn-primary btn-sm" onClick={preview}><RefreshCw size={14} />{loading ? "Carregando..." : sourceKind === "query" ? "Revisar consulta" : "Gerar previa"}</button>}{step === "preview" && <button type="button" onClick={create} disabled={loading || (sourceKind === "query" && columns.length === 0)} className="btn btn-primary btn-sm">{loading ? "Criando..." : "Criar fonte(s)"}</button>}</div>
          </div>
        </div>
        <form method="dialog" className="modal-backdrop"><button>fechar</button></form>
      </dialog>
    </>
  );
}
