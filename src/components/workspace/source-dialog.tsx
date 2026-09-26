"use client";
import { useEffect, useRef, useState } from "react";
import { Cable, CheckCircle2, CircleSlash, DatabaseZap, GitMerge, Play, Plus, RefreshCw, Search, Table2 } from "lucide-react";
import { apiRequest, errorMessage } from "@/lib/api-client";
import { CronPreview } from "./cron-field";

type Connection = { id: string; name: string; provider: string; server: string; databaseName: string };
type SchemaRow = { schema: string };
type TableRow = { schema: string; table: string };
type Column = { originalName: string; sqlName: string; sqlType: string };
type Step = "origin" | "mode" | "incremental" | "preview";

function suggestKeyColumn(cols: Column[]): string {
  const byName = cols.find(c => /^id$/i.test(c.originalName)) ?? cols.find(c => /_id$|Id$/.test(c.originalName));
  return byName?.originalName ?? cols[0]?.originalName ?? "";
}

function suggestDeltaColumn(cols: Column[]): string {
  const isDateType = (t: string) => /DATE|TIME/i.test(t);
  const candidate = cols.find(c => isDateType(c.sqlType) && /updated|modified|update/i.test(c.originalName))
    ?? cols.find(c => isDateType(c.sqlType) && /(_at|data)$/i.test(c.originalName));
  return candidate?.originalName ?? "";
}

function Field({ label, hint, children, wide = false }: { label: string; hint?: string; children: React.ReactNode; wide?: boolean }) {
  return <label className={`form-control w-full ${wide ? "lg:col-span-2" : ""}`}><span className="label-text font-medium">{label}</span><div className="mt-1">{children}</div>{hint && <span className="label-text-alt mt-1 text-base-content/65">{hint}</span>}</label>;
}

function StepItem({ active, done, label }: { active: boolean; done: boolean; label: string }) {
  return <span className={`flex items-center gap-2 rounded-full px-3 py-1 text-xs ${active ? "bg-primary text-primary-content" : done ? "bg-success/10 text-success" : "bg-base-200 text-base-content/65"}`}>{done ? <CheckCircle2 size={13} /> : null}{label}</span>;
}

const DETECT_HINT = "Lê apenas a coluna-chave da origem a cada atualização e marca (sem apagar) as linhas que não existem mais lá. Linhas marcadas nunca aparecem para quem consome os dados.";
const KEYS_SQL_HINT = "Consulta que lista TODAS as chaves da origem: uma coluna, mesmo formato da coluna-chave.";
const KEYS_INTERVAL_HINT = "Limita o custo: a leitura de chaves roda no máximo uma vez neste intervalo. Vazio = a cada atualização.";

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
  const [refreshCron, setRefreshCron] = useState("");
  const [queryName, setQueryName] = useState("");
  const [sourceSql, setSourceSql] = useState("SELECT *\nFROM ");
  const [tableSearch, setTableSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingMeta, setLoadingMeta] = useState(false);
  const [error, setError] = useState("");
  const [incrementalEnabled, setIncrementalEnabled] = useState(false);
  const [keyColumn, setKeyColumn] = useState("");
  const [deltaColumn, setDeltaColumn] = useState("");
  const [detectDeletions, setDetectDeletions] = useState(false);
  const [keysSql, setKeysSql] = useState("");
  const [keysMinInterval, setKeysMinInterval] = useState("");
  const [incrementalColumns, setIncrementalColumns] = useState<Column[]>([]);
  const [loadingIncrementalColumns, setLoadingIncrementalColumns] = useState(false);

  async function open() {
    setStep("origin"); setError(""); setColumns([]); setSelectedTables([]); setQueryStatus("idle"); setQueryTestedSql(""); setTableSearch(""); setRefreshCron("");
    setIncrementalEnabled(false); setKeyColumn(""); setDeltaColumn(""); setIncrementalColumns([]); setDetectDeletions(false); setKeysSql(""); setKeysMinInterval("");
    ref.current?.showModal();
    setLoadingMeta(true);
    try {
      const { data } = await apiRequest<Connection[]>("/api/v1/connections");
      const rows = (data ?? []).filter((c) => c.id);
      setConnections(rows);
      if (rows[0] && !connectionId) setConnectionId(rows[0].id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoadingMeta(false);
    }
  }

  useEffect(() => {
    if (!connectionId) return;
    Promise.resolve().then(() => setLoadingMeta(true));
    apiRequest<SchemaRow[]>(`/api/v1/connections/${connectionId}/schemas`).then(({ data }) => {
      const rows = data ?? [];
      setSchemas(rows);
      setSchema(rows[0]?.schema ?? "");
      setSelectedTables([]);
    }).catch((err) => setError(errorMessage(err))).finally(() => setLoadingMeta(false));
  }, [connectionId]);

  useEffect(() => {
    if (!connectionId || !schema || sourceKind !== "table") return;
    Promise.resolve().then(() => setLoadingMeta(true));
    apiRequest<TableRow[]>(`/api/v1/connections/${connectionId}/tables?schema=${encodeURIComponent(schema)}`).then(({ data }) => {
      setTables(data ?? []);
      setSelectedTables([]);
    }).catch((err) => setError(errorMessage(err))).finally(() => setLoadingMeta(false));
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

  async function enterIncrementalStep() {
    if (mode !== "extract") { await preview(); return; }
    if (sourceKind === "query") {
      if (queryStatus !== "ok" || queryTestedSql !== sourceSql) {
        const ok = await testQuery();
        if (!ok) return;
      }
      setIncrementalColumns(columns);
      if (!keyColumn) setKeyColumn(suggestKeyColumn(columns));
      setStep("incremental");
      return;
    }
    // sourceKind "table": busca colunas da primeira tabela selecionada como amostra para sugestao
    setStep("incremental");
    if (!selectedTables[0]) return;
    setLoadingIncrementalColumns(true);
    try {
      const { data } = await apiRequest<Column[]>(`/api/v1/connections/${connectionId}/columns?schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(selectedTables[0])}`);
      const cols = data ?? [];
      setIncrementalColumns(cols);
      if (!keyColumn) setKeyColumn(suggestKeyColumn(cols));
      if (!deltaColumn) setDeltaColumn(suggestDeltaColumn(cols));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoadingIncrementalColumns(false);
    }
  }

  async function testQuery() {
    if (!connectionId || sourceKind !== "query") return false;
    setLoading(true); setError(""); setQueryStatus("idle");
    try {
      const { data } = await apiRequest<Column[]>(`/api/v1/connections/${connectionId}/columns?sql=${encodeURIComponent(sourceSql)}`);
      setColumns(data ?? []);
      setQueryTestedSql(sourceSql);
      setQueryStatus("ok");
      return true;
    } catch (err) {
      setColumns([]);
      setQueryStatus("error");
      setError(errorMessage(err));
      return false;
    } finally {
      setLoading(false);
    }
  }

  async function create() {
    if (detectDeletions && incrementalEnabled && sourceKind === "query" && !keysSql.trim()) {
      setError("Informe a consulta de chaves para marcar exclusões."); return;
    }
    setLoading(true); setError("");
    const detect = mode === "extract" && incrementalEnabled && !!keyColumn.trim();
    const intervalNum = Number(keysMinInterval);
    const detection = {
      detectDeletions: detect && detectDeletions,
      keysMinIntervalMinutes: detect && detectDeletions && keysMinInterval.trim() && Number.isInteger(intervalNum) && intervalNum >= 1 ? intervalNum : null,
    };
    try {
      await apiRequest(`/api/v1/datasets/${datasetId}/sources`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sourceKind === "table" ? {
          connectionId,
          mode,
          sourceKind,
          sourceSchema: schema,
          sourceTables: selectedTables,
          refreshCron: mode === "live" ? null : (refreshCron.trim() || null),
          keyColumn: mode === "extract" && incrementalEnabled ? (keyColumn.trim() || null) : null,
          deltaColumn: mode === "extract" && incrementalEnabled ? (deltaColumn.trim() || null) : null,
          ...detection,
        } : {
          connectionId,
          name: queryName,
          mode,
          sourceKind,
          sourceSql,
          refreshCron: mode === "live" ? null : (refreshCron.trim() || null),
          keyColumn: mode === "extract" && incrementalEnabled ? (keyColumn.trim() || null) : null,
          ...detection,
          keysSql: detection.detectDeletions ? keysSql.trim() : null,
        }),
      });
      ref.current?.close();
      onComplete();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  const activeConnection = connections.find((c) => c.id === connectionId);
  const providerLabel = activeConnection?.provider === "mssql" ? "SQL Server" : activeConnection?.provider === "firebird-ftp" ? "Firebird" : "Postgres";
  const isFirebirdFtp = activeConnection?.provider === "firebird-ftp";
  const queryIsReady = queryName.trim() && sourceSql.trim() && queryStatus === "ok" && queryTestedSql === sourceSql;
  const canChooseOrigin = connectionId && (sourceKind === "table" ? selectedTables.length > 0 : queryIsReady);
  const modeLabel = mode === "extract" ? "Copiar para o Catworld" : `Consultar direto no ${providerLabel}`;

  return (
    <>
      <button onClick={open} className="btn btn-outline btn-sm"><Plus size={14} />Adicionar fonte</button>
      <dialog ref={ref} className="modal">
        <div className="modal-box max-w-4xl">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div><h3 className="text-lg font-bold">Adicionar fonte de dados</h3><p className="mt-1 text-sm text-base-content/65">Escolha uma ou mais tabelas, ou crie uma fonte a partir de uma consulta.</p></div>
            <div className="flex flex-wrap gap-2"><StepItem label="Origem" active={step === "origin"} done={step !== "origin"} /><StepItem label="Uso" active={step === "mode"} done={step === "incremental" || step === "preview"} /><StepItem label="Sincronizacao" active={step === "incremental"} done={step === "preview"} /><StepItem label="Revisao" active={step === "preview"} done={false} /></div>
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
                <Field label="Conexao"><select className="select w-full" value={connectionId} onChange={(e) => {
                  setConnectionId(e.target.value);
                  // Fontes live nao sao suportadas para firebird-ftp (rejeitado pelo backend) — nao deixar o
                  // modo "ao vivo" selecionado de uma conexao anterior sobreviver a troca para esta.
                  if (connections.find((c) => c.id === e.target.value)?.provider === "firebird-ftp") setMode("extract");
                }}>{connections.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.provider === "mssql" ? "SQL Server" : c.provider === "firebird-ftp" ? "Firebird" : "Postgres"}) - {c.databaseName}</option>)}</select></Field>
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
                                <Search size={13} className="text-base-content/65" />
                                <input type="text" className="grow" placeholder="Pesquisar tabela/view..." value={tableSearch} onChange={e => setTableSearch(e.target.value)} />
                              </label>
                              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-base-content/65 select-none whitespace-nowrap">
                                <input type="checkbox" className="checkbox checkbox-xs" checked={allFilteredSelected} onChange={toggleAll} disabled={filtered.length === 0} />
                                Selecionar todas
                              </label>
                              <span className="text-xs text-base-content/65 whitespace-nowrap">{selectedTables.length} sel.</span>
                            </div>
                            <div className="max-h-64 overflow-auto rounded-box border border-base-300">
                              {tables.length === 0
                                ? <div className="p-4 text-sm text-base-content/65">Nenhuma tabela ou view encontrada neste schema.</div>
                                : filtered.length === 0
                                  ? <div className="p-4 text-sm text-base-content/65">Nenhum resultado para &ldquo;{tableSearch}&rdquo;.</div>
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
                    <Field label="Consulta SQL" hint={isFirebirdFtp ? "Somente SELECT ou WITH. A consulta roda contra o banco Firebird materializado a partir do backup baixado do FTP (dialeto SQL do Firebird, nao Postgres)." : `Somente SELECT ou WITH. A consulta roda no ${providerLabel} da conexao escolhida.`} wide><textarea className="textarea h-44 w-full font-mono text-sm" value={sourceSql} onChange={(e) => { setSourceSql(e.target.value); setQueryStatus("idle"); }} /></Field>
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
              <button type="button" onClick={() => setMode("extract")} className={`rounded-box border p-4 text-left ${mode === "extract" ? "border-primary bg-primary/10" : "border-base-300 bg-base-100"}`}><DatabaseZap className="text-primary" size={22} /><h4 className="mt-3 font-semibold">Copiar para o Catworld</h4><p className="mt-1 text-sm text-base-content/65">Cria tabela(s) fisicas no dataset com o mesmo nome das tabelas selecionadas.</p></button>
              {!isFirebirdFtp && (
                <button type="button" onClick={() => setMode("live")} className={`rounded-box border p-4 text-left ${mode === "live" ? "border-primary bg-primary/10" : "border-base-300 bg-base-100"}`}><Cable className="text-primary" size={22} /><h4 className="mt-3 font-semibold">Consultar direto no {providerLabel}</h4><p className="mt-1 text-sm text-base-content/65">Nao copia dados. Cada visualizacao consulta a origem.</p></button>
              )}
              <Field label="Agendamento (cron UTC)" hint={mode === "live" ? "Fontes ao vivo sempre consultam a origem na hora." : isFirebirdFtp ? "Vazio = sem cron proprio; a fonte ainda atualiza sozinha quando a conexao detecta um arquivo novo no FTP (ver pollMinutes da conexao). Preencha so se quiser tambem uma agenda fixa." : "Vazio = manual. Ex: 0 7-19/2 * * * (a cada 2h das 7-19h)"} wide>
                <input
                  disabled={mode === "live"}
                  className="input w-full font-mono text-sm"
                  placeholder="ex: 0 7-19/2 * * *  —  vazio = manual"
                  value={refreshCron}
                  onChange={(e) => setRefreshCron(e.target.value)}
                />
                {mode !== "live" && refreshCron.trim() && <CronPreview cron={refreshCron} onPick={setRefreshCron} />}
              </Field>
            </div>
          )}

          {step === "incremental" && (
            <div className="mt-5 space-y-5">
              <div className="grid gap-4 lg:grid-cols-2">
                <button type="button" onClick={() => setIncrementalEnabled(false)} className={`rounded-box border p-4 text-left ${!incrementalEnabled ? "border-primary bg-primary/10" : "border-base-300 bg-base-100"}`}><CircleSlash className="text-primary" size={22} /><h4 className="mt-3 font-semibold">Substituir tudo a cada carga</h4><p className="mt-1 text-sm text-base-content/65">Comportamento padrao. Cada atualizacao apaga e recria a tabela com o resultado mais recente.</p></button>
                <button type="button" onClick={() => setIncrementalEnabled(true)} className={`rounded-box border p-4 text-left ${incrementalEnabled ? "border-primary bg-primary/10" : "border-base-300 bg-base-100"}`}><GitMerge className="text-primary" size={22} /><h4 className="mt-3 font-semibold">Sincronizacao incremental</h4><p className="mt-1 text-sm text-base-content/65">Atualiza (upsert) por uma coluna-chave: registros novos entram, registros existentes sao atualizados.</p></button>
              </div>
              {incrementalEnabled && (
                <div className="grid gap-4 lg:grid-cols-2">
                  {loadingIncrementalColumns && <div className="lg:col-span-2 text-sm text-base-content/65"><span className="loading loading-spinner loading-xs mr-2" />Carregando colunas...</div>}
                  <Field label="Coluna-chave (obrigatoria)" hint="Cada linha nova (chave inexistente) e inserida; cada linha existente (mesma chave) e atualizada.">
                    {incrementalColumns.length > 0 ? (
                      <select className="select w-full font-mono text-sm" value={keyColumn} onChange={(e) => setKeyColumn(e.target.value)}>
                        <option value="">Selecione...</option>
                        {incrementalColumns.map((c) => <option key={c.originalName} value={c.originalName}>{c.originalName}</option>)}
                      </select>
                    ) : (
                      <input className="input w-full font-mono text-sm" placeholder="ex: id" value={keyColumn} onChange={(e) => setKeyColumn(e.target.value)} />
                    )}
                  </Field>
                  {sourceKind === "table" ? (
                    <Field label="Coluna delta (opcional)" hint="Requer coluna-chave. Cada carga busca apenas registros com valor maior que o ultimo carregado.">
                      <select className="select w-full font-mono text-sm" value={deltaColumn} onChange={(e) => setDeltaColumn(e.target.value)}>
                        <option value="">Nenhuma (sempre busca tudo)</option>
                        {incrementalColumns.map((c) => <option key={c.originalName} value={c.originalName}>{c.originalName}</option>)}
                      </select>
                    </Field>
                  ) : (
                    <div className="rounded-box border border-base-300 bg-base-200/40 p-3 text-sm text-base-content/65">Para consultas customizadas, o filtro incremental (janela de datas, cortes) deve estar embutido no proprio SQL. O Catworld apenas atualiza (upsert) pela coluna-chave informada.</div>
                  )}
                </div>
              )}

              {incrementalEnabled && keyColumn.trim() && (
                <div className="grid gap-4 lg:grid-cols-2">
                  <label className="flex cursor-pointer items-start gap-3 lg:col-span-2">
                    <input type="checkbox" className="toggle toggle-sm mt-0.5" checked={detectDeletions} onChange={(e) => setDetectDeletions(e.target.checked)} />
                    <span>
                      <span className="label-text font-medium">Marcar como excluídas as linhas que somem da origem</span>
                      <span className="mt-0.5 block text-xs text-base-content/65">{DETECT_HINT}</span>
                    </span>
                  </label>
                  {detectDeletions && sourceKind === "query" && (
                    <Field label="Consulta de chaves" hint={KEYS_SQL_HINT} wide>
                      <textarea className="textarea h-24 w-full font-mono text-sm" value={keysSql} onChange={(e) => setKeysSql(e.target.value)} spellCheck={false} />
                    </Field>
                  )}
                  {detectDeletions && (
                    <Field label="Intervalo mínimo entre leituras (min, opcional)" hint={KEYS_INTERVAL_HINT} wide>
                      <input type="number" min={1} className="input w-full font-mono text-sm" placeholder="vazio = a cada atualização" value={keysMinInterval} onChange={(e) => setKeysMinInterval(e.target.value)} />
                    </Field>
                  )}
                </div>
              )}
            </div>
          )}

          {step === "preview" && (
            <div className="mt-5 space-y-4">
              <div className="rounded-box border border-base-300 bg-base-200/40 p-4 text-sm"><strong>{modeLabel}</strong><span className="ml-2 text-base-content/65">{sourceKind === "table" ? `${selectedTables.length} tabela(s) de ${schema}` : queryName}</span>{mode === "extract" && <span className="ml-2 text-base-content/65">· {incrementalEnabled && keyColumn.trim() ? `Incremental por "${keyColumn.trim()}"${deltaColumn.trim() ? ` (delta: ${deltaColumn.trim()})` : ""}` : "Substitui tudo a cada carga"}</span>}</div>
              {sourceKind === "table" ? <div className="max-h-72 overflow-auto rounded-box border border-base-300"><table className="table table-sm"><thead><tr><th>Tabela {providerLabel}</th><th>Nome no Catworld</th></tr></thead><tbody>{selectedTables.map((t) => <tr key={t}><td className="font-mono text-xs">{schema}.{t}</td><td>{t}</td></tr>)}</tbody></table></div> : columns.length > 0 ? <div className="max-h-72 overflow-auto rounded-box border border-base-300"><table className="table table-sm"><thead><tr><th>Coluna na origem</th><th>Nome no Catworld</th><th>Tipo</th></tr></thead><tbody>{columns.map((c) => <tr key={c.sqlName}><td>{c.originalName}</td><td className="font-mono text-xs">{c.sqlName}</td><td>{c.sqlType}</td></tr>)}</tbody></table></div> : <div className="alert alert-warning alert-soft">Nenhuma coluna carregada. Volte e gere a previa novamente.</div>}
            </div>
          )}

          <div className="modal-action justify-between">
            <div>{step !== "origin" && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setStep(step === "preview" ? (mode === "extract" ? "incremental" : "mode") : step === "incremental" ? "mode" : "origin")}>Voltar</button>}</div>
            <div className="flex gap-2">
              <button type="button" onClick={() => ref.current?.close()} className="btn btn-ghost btn-sm">Fechar</button>
              {step === "origin" && <button type="button" disabled={!canChooseOrigin} className="btn btn-primary btn-sm" onClick={() => setStep("mode")}>Continuar</button>}
              {step === "mode" && <button type="button" disabled={loading} className="btn btn-primary btn-sm" onClick={enterIncrementalStep}><RefreshCw size={14} />{loading ? "Carregando..." : "Continuar"}</button>}
              {step === "incremental" && <button type="button" disabled={loading || (incrementalEnabled && !keyColumn.trim())} className="btn btn-primary btn-sm" onClick={preview}><RefreshCw size={14} />{loading ? "Carregando..." : sourceKind === "query" ? "Revisar consulta" : "Gerar previa"}</button>}
              {step === "preview" && <button type="button" onClick={create} disabled={loading || (sourceKind === "query" && columns.length === 0)} className="btn btn-primary btn-sm">{loading ? "Criando..." : "Criar fonte(s)"}</button>}
            </div>
          </div>
        </div>
        <form method="dialog" className="modal-backdrop"><button>fechar</button></form>
      </dialog>
    </>
  );
}
