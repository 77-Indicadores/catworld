"use client";
import { useRef, useState, useEffect } from "react";
import { Check, Loader2, UploadCloud, XCircle, AlertTriangle } from "lucide-react";
import { previewFileInBrowser, type FilePreviewResult } from "@/lib/duckdb-preview";
import { apiErrorText, apiRequest } from "@/lib/api-client";

type FileJob = {
  id: string;
  file: File;
  uploadId: string;
  status: "uploading" | "previewing" | "importing" | "completed" | "failed";
  statusLabel: string;
  error?: string;
};

type Preview = {
  columns: { originalName: string; sqlName: string; sqlType: string; nullable: boolean }[];
  rows: Record<string, unknown>[];
  rowCount: number;
};

let jobCounter = 0;

export function UploadFlow({
  datasetId,
  targetTable,
  onComplete,
}: {
  datasetId: string;
  targetTable?: { id: string; name: string } | null;
  onComplete: () => void;
}) {
  const [jobs, setJobs] = useState<FileJob[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [globalError, setGlobalError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const processingRef = useRef(false);
  const datasetRef = useRef(datasetId);
  const targetTableRef = useRef(targetTable);
  const onCompleteRef = useRef(onComplete);

  // Keep refs in sync
  useEffect(() => { datasetRef.current = datasetId; }, [datasetId]);
  useEffect(() => { targetTableRef.current = targetTable; }, [targetTable]);
  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);

  function addFiles(files: FileList | File[]) {
    const valid = Array.from(files).filter(
      (f) => /\.(csv|xlsx|xls)$/i.test(f.name)
    );
    if (valid.length === 0) {
      setGlobalError("Nenhum arquivo compatível (CSV, XLSX ou XLS) selecionado.");
      return;
    }
    setGlobalError("");
    const newJobs: FileJob[] = valid.map((f) => ({
      id: `${++jobCounter}-${Date.now()}`,
      file: f,
      uploadId: "",
      status: "uploading",
      statusLabel: "Enviando...",
    }));
    setJobs((prev) => [...prev, ...newJobs]);
  }

  // Kick off processing when new "uploading" jobs appear
  useEffect(() => {
    const pending = jobs.filter((j) => j.status === "uploading");
    if (pending.length === 0 || processingRef.current) return;

    processingRef.current = true;
    const dId = datasetRef.current;
    const tt = targetTableRef.current;
    const oc = onCompleteRef.current;

    const processOne = async (job: FileJob) => {
      const update = (patch: Partial<FileJob>) =>
        setJobs((prev) => prev.map((j) => (j.id === job.id ? { ...j, ...patch } : j)));

      let uploadId = "";
      try {
        // 0) Try browser-side preview with DuckDB-WASM (CSV only, XLSX falls back)
        update({ status: "previewing", statusLabel: "Analisando..." });
        let browserPreview: FilePreviewResult | null = null;
        try {
          browserPreview = await previewFileInBrowser(job.file);
        } catch {
          // Non-fatal: fall back to server-side preview
        }

        update({ status: "uploading", statusLabel: "Enviando..." });

        // 1) Create upload entry — include preview data if computed in browser
        const createBody: Record<string, unknown> = {
          filename: job.file.name,
          sizeBytes: job.file.size,
          datasetId: dId,
          mode: "replace",
        };
        if (tt?.id) createBody.tableId = tt.id;
        if (browserPreview) {
          createBody.previewJson = JSON.stringify(browserPreview);
          createBody.mappingJson = JSON.stringify(browserPreview.columns);
          createBody.rowCount = browserPreview.rowCount;
        }

        if (!/\.(csv|xlsx|xls)$/i.test(job.file.name)) throw new Error("Formato não suportado. Use CSV, XLSX ou XLS.");
        const { data: created } = await apiRequest<{ skip?: boolean; upload?: { id: string }; sas?: { url: string } }>("/api/v1/uploads", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(createBody),
        });

        if (created.skip) {
          update({ status: "completed", statusLabel: "Concluído (sem alterações)" });
          oc();
          return;
        }

        uploadId = created.upload!.id;
        update({ uploadId });

        // 2) Upload to blob — URL de armazenamento (SAS), não é a API do Catworld: fica de fora do
        // envelope {data,meta,error} e por isso usa fetch cru mesmo.
        const r = await fetch(created.sas!.url, {
          method: "PUT",
          headers: { "content-type": job.file.type || "application/octet-stream" },
          body: job.file,
        });
        if (!r.ok) throw new Error(apiErrorText(await r.json().catch(() => null), "Falha ao enviar o arquivo. Tente de novo.", r.status));

        // 3) Notify uploaded — if browser preview was set, server skips PREVIEW_UPLOAD
        //    and queues IMPORT_UPLOAD directly (no poll for preview needed)
        await apiRequest(`/api/v1/uploads/${uploadId}?action=uploaded`, { method: "POST" });

        update({ status: "importing", statusLabel: "Importando..." });

        if (browserPreview) {
          // Fast path: preview already done, skip straight to polling for completion
          await pollForCompletion(uploadId, (label) => update({ statusLabel: label }));
        } else {
          // Slow path: wait for server-side preview, then confirm
          update({ status: "previewing", statusLabel: "Analisando..." });
          const preview = await pollForPreview(uploadId, (label) => update({ statusLabel: label }));

          update({ status: "importing", statusLabel: "Importando..." });
          await apiRequest(`/api/v1/uploads/${uploadId}?action=confirm`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              datasetId: dId,
              tableId: tt?.id ?? null,
              mode: "replace",
              keyColumn: null,
              mapping: preview.columns,
            }),
          });

          await pollForCompletion(uploadId, (label) => update({ statusLabel: label }));
        }

        update({ status: "completed", statusLabel: "Concluído" });
        oc();
      } catch (e) {
        // Before marking as failed locally, check the real DB status —
        // a transient network/poll error might have thrown while the server completed normally.
        let actuallyFailed = true;
        if (uploadId) {
          try {
            const { data } = await apiRequest<{ status?: string }>(`/api/v1/uploads/${uploadId}`);
            if (data?.status === "COMPLETED") actuallyFailed = false;
          } catch { /* ignore — show failed */ }
        }
        if (!actuallyFailed) {
          update({ status: "completed", statusLabel: "Concluído" });
          oc();
        } else {
          update({
            status: "failed",
            statusLabel: "Falhou",
            error: e instanceof Error ? e.message : "Erro desconhecido",
          });
        }
      }
    };

    Promise.allSettled(pending.map(processOne)).finally(() => {
      processingRef.current = false;
    });
  }, [jobs]);

  const allDone = jobs.length > 0 && jobs.every((j) => j.status === "completed");
  const hasFailed = jobs.some((j) => j.status === "failed");
  const totalComplete = jobs.filter((j) => j.status === "completed").length;

  function reset() {
    setJobs([]);
    setGlobalError("");
    processingRef.current = false;
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files.length > 0) addFiles(e.target.files);
    if (inputRef.current) inputRef.current.value = "";
  }

  if (allDone) {
    return (
      <div className="rounded-box border border-base-300 bg-base-100 py-10 text-center">
        <span className="mx-auto grid size-14 place-items-center rounded-full bg-success text-success-content">
          <Check />
        </span>
        <h3 className="mt-4 text-lg font-semibold">
          {totalComplete} arquivo{totalComplete > 1 ? "s" : ""} importado
          {totalComplete > 1 ? "s" : ""} com sucesso
        </h3>
        {hasFailed && (
          <p className="mt-1 text-sm text-warning">
            {jobs.filter((j) => j.status === "failed").length} falha
            {jobs.filter((j) => j.status === "failed").length > 1 ? "ram" : ""}{" "}
            — veja detalhes abaixo
          </p>
        )}
        <button onClick={reset} className="btn btn-primary btn-sm mt-5">
          Novo upload
        </button>
        {hasFailed && (
          <div className="mx-auto mt-4 max-w-md text-left">
            {jobs.filter((j) => j.status === "failed").map((j) => (
              <div key={j.id} className="alert alert-error alert-soft mb-2 text-xs">
                <XCircle size={14} />
                <span><strong>{j.file.name}</strong>: {j.error}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (jobs.length > 0) {
    return (
      <div className="rounded-box border border-base-300 bg-base-100 p-5">
        <h3 className="text-sm font-semibold">
          Importando {jobs.length} arquivo{jobs.length > 1 ? "s" : ""}
        </h3>
        <p className="text-xs text-base-content/65">
          Você pode sair desta tela — o processamento continua no servidor.
        </p>
        <div className="mt-4 grid gap-2">
          {jobs.map((j) => (
            <div
              key={j.id}
              className={`flex items-center gap-3 rounded-lg border px-3 py-2 text-sm ${
                j.status === "failed"
                  ? "border-error/30 bg-error/5"
                  : j.status === "completed"
                    ? "border-success/30 bg-success/5"
                    : "border-base-300 bg-base-200/30"
              }`}
            >
              {j.status === "uploading" || j.status === "previewing" || j.status === "importing" ? (
                <Loader2 size={16} className="animate-spin text-primary" />
              ) : j.status === "completed" ? (
                <Check size={16} className="text-success" />
              ) : (
                <XCircle size={16} className="text-error" />
              )}
              <span className="flex-1 truncate font-medium">{j.file.name}</span>
              <span
                className={`text-xs ${
                  j.status === "failed"
                    ? "text-error"
                    : j.status === "completed"
                      ? "text-success"
                      : "text-base-content/65"
                }`}
              >
                {j.statusLabel}
              </span>
            </div>
          ))}
        </div>
        {hasFailed && (
          <div className="mt-3 text-xs text-error">
            <AlertTriangle size={14} className="inline" /> Alguns arquivos falharam. Você pode tentar novamente.
          </div>
        )}
        <div className="mt-4 flex gap-2">
          <button onClick={reset} className="btn btn-ghost btn-sm">
            Cancelar tudo
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      className={`rounded-box border-2 border-dashed p-10 text-center transition-colors ${
        dragOver ? "border-primary bg-primary/10" : "border-base-300 bg-base-200/40"
      }`}
    >
      <UploadCloud className="mx-auto text-primary" size={32} />
      <p className="mt-3 text-sm font-medium">
        Arraste arquivos aqui{" "}
        {targetTable
          ? `para atualizar "${targetTable.name}"`
          : "para criar tabelas automaticamente"}
      </p>
      <p className="mt-1 text-xs text-base-content/65">
        CSV, XLSX ou XLS — vários arquivos de uma vez
      </p>
      <p className="mt-1 text-xs text-base-content/65">ou</p>
      <input
        ref={inputRef}
        type="file"
        accept=".csv,.xlsx,.xls"
        multiple
        className="hidden"
        onChange={handleInputChange}
      />
      <button
        onClick={() => inputRef.current?.click()}
        className="btn btn-outline btn-sm mt-3"
      >
        Selecionar arquivos
      </button>
      {globalError && (
        <div className="alert alert-error alert-soft mt-4 text-sm">{globalError}</div>
      )}
    </div>
  );
}

async function pollForPreview(
  uploadId: string,
  onStatus: (label: string) => void
): Promise<Preview> {
  for (let i = 0; i < 180; i++) {
    const { data: u } = await apiRequest<{ status: string; previewJson: string; errorMessage?: string }>(`/api/v1/uploads/${uploadId}`);
    onStatus(u.status);
    if (u.status === "AWAITING_CONFIRMATION") {
      return JSON.parse(u.previewJson) as Preview;
    }
    if (u.status === "FAILED") throw new Error(u.errorMessage ?? "Processamento falhou");
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("Tempo de processamento excedido");
}

const STATUS_LABELS: Record<string, string> = {
  PENDING_UPLOAD: "Aguardando upload...",
  PENDING_BLOB: "Armazenando arquivo...",
  QUEUED_PREVIEW: "Na fila de pré-visualização...",
  PREVIEWING: "Gerando pré-visualização...",
  PREVIEW_READY: "Pré-visualização pronta",
  QUEUED_IMPORT: "Na fila de importação...",
  IMPORTING: "Importando...",
  COMPLETED: "Concluído",
  FAILED: "Falhou",
};

async function pollForCompletion(
  uploadId: string,
  onStatus: (label: string) => void
): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const { data: u } = await apiRequest<{ status: string; errorMessage?: string }>(`/api/v1/uploads/${uploadId}`);
    onStatus(STATUS_LABELS[u.status] ?? u.status);
    if (u.status === "COMPLETED") return;
    if (u.status === "FAILED") throw new Error(u.errorMessage ?? "Importação falhou");
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("Tempo de importação excedido");
}