"use client";

import { useRef, useState } from "react";
import { Cron } from "croner";
import { Pencil, Play } from "lucide-react";

type Column = { originalName: string; sqlName: string; sqlType: string };
type Source = {
  id: string;
  name: string;
  mode: string;
  refreshCron: string | null;
  keyColumn: string | null;
  deltaColumn: string | null;
  sourceKind: string;
  sourceSql?: string | null;
  connection: { id: string; name: string };
};

function CronPreview({ cron }: { cron: string }) {
  try {
    const c = new Cron(cron.trim(), { timezone: "UTC" });
    const n1 = c.nextRun();
    const n2 = n1 ? c.nextRun(n1) : null;
    const fmt = (d: Date) =>
      d.toLocaleString("pt-BR", { timeZone: "UTC", dateStyle: "short", timeStyle: "short" }) + " UTC";
    return (
      <span className="label-text-alt mt-1 text-base-content/55">
        Próximo: {n1 ? fmt(n1) : "—"}{n2 ? ` · depois: ${fmt(n2)}` : ""}
      </span>
    );
  } catch {
    return <span className="label-text-alt mt-1 text-warning">Expressão cron inválida</span>;
  }
}

export function SourceEditDialog({ source, onComplete }: { source: Source; onComplete: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(source.name);
  const [mode, setMode] = useState(source.mode);
  const [refreshCron, setRefreshCron] = useState(source.refreshCron ?? "");
  const [keyColumn, setKeyColumn] = useState(source.keyColumn ?? "");
  const [deltaColumn, setDeltaColumn] = useState(source.deltaColumn ?? "");
  const [sql, setSql] = useState(source.sourceSql ?? "");
  const [sqlTested, setSqlTested] = useState(source.sourceSql ?? "");
  const [sqlStatus, setSqlStatus] = useState<"idle" | "ok" | "error">("ok");
  const [columns, setColumns] = useState<Column[]>([]);
  const [testing, setTesting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  function open() {
    setName(source.name);
    setMode(source.mode);
    setRefreshCron(source.refreshCron ?? "");
    setKeyColumn(source.keyColumn ?? "");
    setDeltaColumn(source.deltaColumn ?? "");
    setSql(source.sourceSql ?? "");
    setSqlTested(source.sourceSql ?? "");
    setSqlStatus("ok");
    setColumns([]);
    setError("");
    ref.current?.showModal();
  }

  async function testQuery() {
    setTesting(true); setError(""); setSqlStatus("idle");
    const response = await fetch(`/api/v1/connections/${source.connection.id}/columns?sql=${encodeURIComponent(sql)}`);
    const body = await response.json();
    setTesting(false);
    if (!response.ok) { setSqlStatus("error"); setError(body.error?.message ?? "Falha ao testar consulta"); return; }
    setColumns(body.data ?? []);
    setSqlTested(sql);
    setSqlStatus("ok");
  }

  async function save() {
    if (source.sourceKind === "query" && (sqlStatus !== "ok" || sql !== sqlTested)) {
      setError("Teste a consulta antes de salvar."); return;
    }
    setLoading(true); setError("");
    const body: Record<string, unknown> = {
      name: name.trim(),
      mode,
      refreshCron: mode === "live" ? null : (refreshCron.trim() || null),
      keyColumn: keyColumn.trim() || null,
      deltaColumn: deltaColumn.trim() || null,
    };
    if (source.sourceKind === "query") body.sourceSql = sql;
    const response = await fetch(`/api/v1/dataset-sources/${source.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setLoading(false);
    if (!response.ok) { const b = await response.json(); setError(b.error?.message ?? "Falha ao salvar"); return; }
    ref.current?.close();
    onComplete();
  }

  const sqlChanged = sql !== sqlTested;

  return (
    <>
      <button className="btn btn-ghost btn-xs" onClick={open} title="Editar fonte">
        <Pencil size={13} />Editar
      </button>
      <dialog ref={ref} className="modal">
        <div className="modal-box max-w-2xl">
          <h3 className="text-lg font-bold">Editar fonte</h3>
          <p className="mt-1 text-xs text-base-content/50">{source.connection.name} · {source.sourceKind === "query" ? "Consulta personalizada" : "Tabela"}</p>

          <div className="mt-5 space-y-4">
            <label className="form-control w-full">
              <span className="label-text font-medium">Nome</span>
              <input className="input mt-1 w-full" value={name} onChange={(e) => setName(e.target.value)} />
            </label>

            {source.sourceKind === "query" && (
              <div>
                <span className="label-text font-medium">Consulta SQL</span>
                <textarea
                  className="textarea mt-1 h-44 w-full font-mono text-sm"
                  value={sql}
                  onChange={(e) => { setSql(e.target.value); setSqlStatus("idle"); }}
                  spellCheck={false}
                />
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button type="button" className="btn btn-outline btn-sm" onClick={testQuery} disabled={testing || !sql.trim()}>
                    <Play size={13} />{testing ? "Testando..." : "Testar consulta"}
                  </button>
                  {sqlStatus === "ok" && !sqlChanged && (
                    <span className="badge badge-success badge-outline">{columns.length > 0 ? `${columns.length} coluna(s) ok` : "Consulta válida"}</span>
                  )}
                  {sqlChanged && <span className="text-xs text-warning">Consulta alterada — teste antes de salvar.</span>}
                </div>
                {columns.length > 0 && sqlStatus === "ok" && !sqlChanged && (
                  <div className="mt-3 max-h-40 overflow-auto rounded-box border border-base-300">
                    <table className="table table-sm">
                      <thead><tr><th>Coluna</th><th>Nome no Catworld</th><th>Tipo</th></tr></thead>
                      <tbody>{columns.map(c => <tr key={c.sqlName}><td>{c.originalName}</td><td className="font-mono text-xs">{c.sqlName}</td><td>{c.sqlType}</td></tr>)}</tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            <label className="form-control w-full">
              <span className="label-text font-medium">Modo</span>
              <select className="select mt-1 w-full" value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="extract">Copiar para o Catworld</option>
                <option value="live">Consultar direto na origem</option>
              </select>
            </label>

            <label className="form-control w-full">
              <span className="label-text font-medium">Agendamento (cron UTC)</span>
              <input
                className="input mt-1 w-full font-mono text-sm"
                placeholder="ex: 0 7-19/2 * * *  —  vazio = manual"
                value={refreshCron}
                onChange={(e) => setRefreshCron(e.target.value)}
                disabled={mode === "live"}
              />
              {mode !== "live" && refreshCron.trim() && <CronPreview cron={refreshCron} />}
              {mode !== "live" && !refreshCron.trim() && (
                <span className="label-text-alt mt-1 text-base-content/55">Vazio = sem agendamento automático</span>
              )}
              {mode === "live" && <span className="label-text-alt mt-1 text-base-content/55">Fontes ao vivo sempre consultam a origem na hora.</span>}
            </label>

            {mode === "extract" && (
              <label className="form-control w-full">
                <span className="label-text font-medium">Coluna-chave para upsert <span className="font-normal text-base-content/50">(opcional)</span></span>
                <input className="input mt-1 w-full font-mono text-sm" placeholder="ex: id" value={keyColumn} onChange={(e) => setKeyColumn(e.target.value)} />
                <span className="label-text-alt mt-1 text-base-content/55">Se definida, cada atualização faz upsert pela chave em vez de substituir a tabela inteira.</span>
              </label>
            )}

            {mode === "extract" && source.sourceKind === "table" && (
              <label className="form-control w-full">
                <span className="label-text font-medium">Coluna delta (incremental) <span className="font-normal text-base-content/50">(opcional)</span></span>
                <input className="input mt-1 w-full font-mono text-sm" placeholder="ex: updated_at" value={deltaColumn} onChange={(e) => setDeltaColumn(e.target.value)} />
                <span className="label-text-alt mt-1 text-base-content/55">Requer coluna-chave. Cada carga busca apenas registros com valor maior que o último carregado.</span>
              </label>
            )}
          </div>

          {error && <div className="alert alert-error alert-soft mt-4 text-sm">{error}</div>}

          <div className="modal-action">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => ref.current?.close()}>Cancelar</button>
            <button type="button" className="btn btn-primary btn-sm" disabled={loading || !name.trim()} onClick={save}>
              {loading ? "Salvando..." : "Salvar alterações"}
            </button>
          </div>
        </div>
        <form method="dialog" className="modal-backdrop"><button>fechar</button></form>
      </dialog>
    </>
  );
}
