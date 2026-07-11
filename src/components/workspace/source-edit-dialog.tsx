"use client";

import { useRef, useState } from "react";
import { Pencil, Play } from "lucide-react";

type Column = { originalName: string; sqlName: string; sqlType: string };
type Source = {
  id: string;
  name: string;
  mode: string;
  refreshPolicy: string;
  sourceKind: string;
  sourceSql?: string | null;
  connection: { id: string; name: string };
};

export function SourceEditDialog({ source, onComplete }: { source: Source; onComplete: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(source.name);
  const [mode, setMode] = useState(source.mode);
  const [policy, setPolicy] = useState(source.refreshPolicy);
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
    setPolicy(source.refreshPolicy);
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
      refreshPolicy: mode === "live" ? "manual" : policy,
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
            {/* Nome */}
            <label className="form-control w-full">
              <span className="label-text font-medium">Nome</span>
              <input className="input mt-1 w-full" value={name} onChange={(e) => setName(e.target.value)} />
            </label>

            {/* SQL query — só para fontes de consulta */}
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
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    onClick={testQuery}
                    disabled={testing || !sql.trim()}
                  >
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

            {/* Mode */}
            <label className="form-control w-full">
              <span className="label-text font-medium">Modo</span>
              <select className="select mt-1 w-full" value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="extract">Copiar para o Catworld</option>
                <option value="live">Consultar direto na origem</option>
              </select>
            </label>

            {/* Refresh policy */}
            <label className="form-control w-full">
              <span className="label-text font-medium">Atualização automática</span>
              <select className="select mt-1 w-full" disabled={mode === "live"} value={policy} onChange={(e) => setPolicy(e.target.value)}>
                <option value="manual">Manual</option>
                <option value="hourly">A cada hora</option>
                <option value="daily">Diária</option>
                <option value="weekly">Semanal</option>
              </select>
              {mode === "live" && <span className="label-text-alt mt-1 text-base-content/55">Fontes ao vivo sempre consultam a origem na hora.</span>}
            </label>
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
