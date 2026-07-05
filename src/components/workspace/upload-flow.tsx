"use client";
import { useRef, useState } from "react";
import { Check, UploadCloud } from "lucide-react";

type Preview = { columns: { originalName: string; sqlName: string; sqlType: string; nullable: boolean }[]; rows: Record<string, unknown>[]; rowCount: number };

export function UploadFlow({ datasetId, targetTable, onComplete }: { datasetId: string; targetTable?: { id: string; name: string } | null; onComplete: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [uploadId, setUploadId] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mode, setMode] = useState("replace");
  const [keyColumn, setKeyColumn] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function reset() { setFile(null); setUploadId(""); setPreview(null); setMode("replace"); setKeyColumn(""); setStatus(""); setError(""); }

  async function begin(picked: File) {
    setFile(picked); setError(""); setStatus("Enviando arquivo...");
    try {
      const first = await fetch("/api/v1/uploads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ filename: picked.name, sizeBytes: picked.size }) });
      const b = await first.json();
      if (!first.ok) throw new Error(b.error?.message);
      setUploadId(b.data.upload.id);
      const r = await fetch(b.data.sas.url, { method: "PUT", headers: { "content-type": picked.type || "application/octet-stream" }, body: picked });
      if (!r.ok) throw new Error("Falha ao enviar arquivo");
      await fetch(`/api/v1/uploads/${b.data.upload.id}?action=uploaded`, { method: "POST" });
      await poll(b.data.upload.id, "AWAITING_CONFIRMATION");
    } catch (e) { setError(e instanceof Error ? e.message : "Falha no upload"); }
  }
  async function poll(id: string, target: string) {
    for (let i = 0; i < 180; i++) {
      const r = await fetch(`/api/v1/uploads/${id}`), b = await r.json(), u = b.data;
      setStatus(u.status);
      if (u.status === target) { if (u.previewJson) setPreview(JSON.parse(u.previewJson)); return; }
      if (u.status === "FAILED") throw new Error(u.errorMessage ?? "Processamento falhou");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error("Tempo de processamento excedido");
  }
  async function confirm() {
    if (!preview || !uploadId) return;
    setStatus("QUEUED_IMPORT");
    try {
      const r = await fetch(`/api/v1/uploads/${uploadId}?action=confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ datasetId, tableId: targetTable?.id ?? null, mode, keyColumn: mode === "upsert" ? keyColumn : null, mapping: preview.columns }) });
      const b = await r.json();
      if (!r.ok) throw new Error(b.error?.message);
      await poll(uploadId, "COMPLETED");
      onComplete();
    } catch (e) { setError(e instanceof Error ? e.message : "Importação falhou"); }
  }

  const completed = status === "COMPLETED";
  if (completed) return (
    <div className="rounded-box border border-base-300 bg-base-100 py-10 text-center">
      <span className="mx-auto grid size-14 place-items-center rounded-full bg-success text-success-content"><Check /></span>
      <h3 className="mt-4 text-lg font-semibold">Importação concluída</h3>
      <button onClick={reset} className="btn btn-primary btn-sm mt-5">Novo upload</button>
    </div>
  );

  if (!preview) return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); const dropped = e.dataTransfer.files[0]; if (dropped) void begin(dropped); }}
      className={`rounded-box border-2 border-dashed p-10 text-center transition-colors ${dragOver ? "border-primary bg-primary/10" : "border-base-300 bg-base-200/40"}`}
    >
      <UploadCloud className="mx-auto text-primary" size={32} />
      <p className="mt-3 text-sm font-medium">Arraste um arquivo aqui {targetTable ? `para atualizar "${targetTable.name}"` : "para criar uma nova tabela"}</p>
      <p className="mt-1 text-xs text-base-content/50">ou</p>
      <input ref={inputRef} type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={(e) => { const picked = e.target.files?.[0]; if (picked) void begin(picked); }} />
      <button onClick={() => inputRef.current?.click()} disabled={Boolean(status)} className="btn btn-outline btn-sm mt-3">{status || "Selecionar arquivo"}</button>
      {file && !status.startsWith("Enviando") && <p className="mt-2 text-xs text-base-content/55">{file.name}</p>}
      {error && <div className="alert alert-error alert-soft mt-4">{error}</div>}
    </div>
  );

  return (
    <div className="rounded-box border border-base-300 bg-base-100 p-5">
      <h3 className="text-sm font-semibold">Prévia pronta</h3>
      <p className="text-xs text-base-content/55">{preview.rowCount.toLocaleString("pt-BR")} linhas detectadas.</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <select value={mode} onChange={(e) => setMode(e.target.value)} className="select select-sm w-full">
          <option value="replace">{targetTable ? "Substituir tabela" : "Criar tabela"}</option>
          <option value="append">Adicionar</option>
          <option value="upsert">Upsert</option>
        </select>
        {mode === "upsert" && <select value={keyColumn} onChange={(e) => setKeyColumn(e.target.value)} className="select select-sm w-full"><option value="">Coluna-chave</option>{preview.columns.map((c) => <option key={c.sqlName}>{c.sqlName}</option>)}</select>}
      </div>
      <div className="mt-4 max-h-48 overflow-y-auto overflow-x-auto rounded-lg border border-base-300">
        <table className="table table-sm"><thead><tr><th>Original</th><th>SQL</th><th>Tipo</th></tr></thead><tbody>{preview.columns.map((c) => <tr key={c.sqlName}><td>{c.originalName}</td><td className="font-mono text-xs">{c.sqlName}</td><td>{c.sqlType}</td></tr>)}</tbody></table>
      </div>
      <div className="mt-4 flex gap-2">
        <button onClick={reset} className="btn btn-ghost btn-sm">Cancelar</button>
        <button disabled={mode === "upsert" && !keyColumn} onClick={confirm} className="btn btn-primary btn-sm flex-1">{status && status !== "AWAITING_CONFIRMATION" ? status : "Confirmar importação"}</button>
      </div>
      {error && <div className="alert alert-error alert-soft mt-4">{error}</div>}
    </div>
  );
}
