import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import * as Sentry from "@sentry/node";
import { prisma } from "@/server/db";
import { downloadFile, deleteFile } from "@/server/storage";
import { env } from "@/server/env";
import { previewFile, applyTypeOverrides, type FilePreview } from "@/server/uploads/parser";
import { importUpload } from "@/server/uploads/importer";
import { queueImportUploadAuto } from "@/server/uploads/actions";
import { enqueueDueSourceRefreshes, enqueueDueReconciliations, refreshDatasetSource, nextRefreshFromCron } from "@/server/connections/sources";
import { enqueueDueDerivedRefreshes, refreshDerivedTable } from "@/server/connections/derived";
import { pickInt } from "@/server/worker/config";
import { auditJob } from "@/server/audit-request";
import { startHeartbeat, currentRssMb, recordJobMetric, writeWorkerLiveness, readWorkerLiveness, clearWorkerLiveness } from "./metrics";
import { setDuckdbMemoryLimit } from "@/server/worker/runtime-limits";
import { WorkerState, identityConflict, isPidAlive, listProfileNames, loadProfile, parseProfileArg, type WorkerProfileRow } from "./runtime";

// Camada 1 (auditoria): o processo do worker (tsx src/worker/index.ts) roda fora
// do ciclo de vida do Next.js — instrumentation.ts (que inicializa o Sentry pro
// processo "web") nunca é carregado aqui, entao ate agora o worker nao tinha
// captura de erro nenhuma. Mesmo DSN do sentry.server.config.ts.
Sentry.init({
  dsn: "https://43a7acb9f1f89e58168a8e79567281cb@o4511632763191296.ingest.us.sentry.io/4511667797622784",
  tracesSampleRate: 0.1,
  enableLogs: true,
  serverName: `${parseProfileArg(process.argv) ?? "worker"}@${hostname()}`,
});
process.on("uncaughtException", (e) => { Sentry.captureException(e); console.error("[worker] uncaughtException:", e); });
process.on("unhandledRejection", (e) => { Sentry.captureException(e); console.error("[worker] unhandledRejection:", e); });

type Claimed = { id: string; type: string; upload_id: string | null; payload_json: string | null; attempts: number; max_attempts: number; weight: number };

// Identidade e config deste processo: o perfil (banco), escolhido por `--profile <nome>` — sem variável de ambiente.
let profile: WorkerProfileRow;
const state = new WorkerState();
process.on("SIGTERM", () => { state.stopping = true; });
process.on("SIGINT", () => { state.stopping = true; });
// O supervisor conversa por IPC: {type:"drain"} = para de pegar job novo, termina os em andamento e sai.
process.on("message", (m) => { if ((m as { type?: string } | null)?.type === "drain") state.draining = true; });
process.on("disconnect", () => { state.draining = true; }); // supervisor morreu: não fica órfão

/** Espera até `ms`, mas acorda logo se o worker foi mandado parar/drenar (um poll longo não atrasa o reinício). */
async function nap(ms: number) {
  const end = Date.now() + ms;
  while (state.canClaim && Date.now() < end) await new Promise(r => setTimeout(r, Math.min(500, Math.max(0, end - Date.now()))));
}

async function claim(lockedBy: string, maxHeavy: number, maxSyncsPerStorage: number, allowedTypes: string[] | null): Promise<Claimed | null> {
  const typeFilter = allowedTypes && allowedTypes.length > 0
    ? `AND j.type IN (${allowedTypes.map(t => `'${t.replace(/'/g, "''")}'`).join(",")})`
    : "";
  // storage_server_id só é setado em jobs SOURCE_REFRESH (ver queueSourceRefresh em
  // sources.ts) — NULL pra qualquer outro tipo de job, que por isso nunca é gateado
  // por esse teto (a condição vira um no-op quando j.storage_server_id IS NULL).
  // Igual ao teto de weight/max_heavy_jobs, isso é enforçado aqui no claim() — o job
  // sempre entra na fila (QUEUED) na hora de criar, o teto só decide quando ele pode
  // começar a rodar. Antes disso era enforçado (errado) na hora de enfileirar, o que
  // podia "perder a vaga" indefinidamente sem nunca sequer entrar na fila.
  const rows = await prisma.$queryRawUnsafe<Claimed[]>(
    `UPDATE cw_jobs
     SET status='RUNNING',locked_at=NOW(),heartbeat_at=NOW(),locked_by=$1,attempts=attempts+1
     WHERE id=(
       SELECT j.id FROM cw_jobs j
       WHERE j.status='QUEUED' AND j.available_at<=NOW()
         ${typeFilter}
         AND (j.weight<2 OR (SELECT COUNT(*) FROM cw_jobs WHERE status='RUNNING' AND weight=2)<$2)
         AND (j.storage_server_id IS NULL OR (SELECT COUNT(*) FROM cw_jobs r WHERE r.status='RUNNING' AND r.storage_server_id=j.storage_server_id)<$3)
       ORDER BY j.weight ASC,j.available_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id,type,upload_id,payload_json,attempts,max_attempts,weight`,
    lockedBy,
    maxHeavy,
    maxSyncsPerStorage,
  );
  return rows[0] ?? null;
}

async function localFile(upload: { blobName: string; originalFilename: string }) {
  const dir = await mkdtemp(join(tmpdir(), "catworld-"));
  const path = join(dir, basename(upload.originalFilename));
  await pipeline(await downloadFile(upload.blobName), createWriteStream(path));
  if (extname(path).toLowerCase() !== ".xls") return { dir, path };
  const converted = await convertLegacy(path, dir);
  return { dir, path: converted };
}

// Downloads blobName to a temp file so the import uses the DuckDB server-side path
// — same parser as the client-side preview.
async function localOriginals(upload: { blobName: string; originalFilename: string }) {
  const dir = await mkdtemp(join(tmpdir(), "catworld-"));
  const path = join(dir, basename(upload.originalFilename));
  await pipeline(await downloadFile(upload.blobName), createWriteStream(path));
  return { dir, path };
}

async function convertLegacy(path: string, dir: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("soffice", ["--headless", "--convert-to", "xlsx", "--outdir", dir, path], { stdio: "ignore" });
    child.on("exit", code => code === 0 ? resolve() : reject(new Error("Falha ao converter XLS legado com LibreOffice")));
    child.on("error", reject);
  });
  return join(dir, `${basename(path, ".xls")}.xlsx`);
}

async function runMetadataCleanup() {
  const t0 = Date.now();

  // Registra o início da execução e obtém o ID para atualizar ao final
  const runRow = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO cw_cleanup_runs (started_at) VALUES (NOW()) RETURNING id`,
  );
  const runId = runRow[0]?.id;

  try {
    // Lê configurações de retenção do Postgres via SQL direto (evita dependência do Prisma client gerado)
    const rows = await prisma.$queryRawUnsafe<{ key: string; value: string }[]>(
      `SELECT key, value FROM cw_system_settings WHERE key = ANY($1::text[])`,
      ["retention.jobs_days", "retention.audit_events_days", "retention.uploads_days", "retention.dataset_versions_keep"],
    );
    const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    // Valor invalido/fora da faixa cai no default (nunca NaN, que abortava o cleanup inteiro).
    const jobsDays     = pickInt(cfg["retention.jobs_days"], 30, 1, 3650);
    const auditDays    = pickInt(cfg["retention.audit_events_days"], 30, 1, 3650);
    const uploadsDays  = pickInt(cfg["retention.uploads_days"], 30, 1, 3650);
    const versionsKeep = pickInt(cfg["retention.dataset_versions_keep"], 10, 1, 1000);

    const deletedJobs = await prisma.$executeRawUnsafe(
      `DELETE FROM cw_jobs WHERE status IN ('COMPLETED','FAILED') AND created_at < NOW() - ($1 || ' days')::INTERVAL`,
      String(jobsDays),
    );

    const deletedAudit = await prisma.$executeRawUnsafe(
      `DELETE FROM cw_audit_events WHERE created_at < NOW() - ($1 || ' days')::INTERVAL`,
      String(auditDays),
    );

    // Fetch blobNames before deleting so we can clean up the files on disk.
    const expiredUploads = await prisma.$queryRawUnsafe<{ blob_name: string }[]>(
      `SELECT blob_name FROM cw_uploads WHERE status IN ('COMPLETED','FAILED','CANCELLED') AND created_at < NOW() - ($1 || ' days')::INTERVAL`,
      String(uploadsDays),
    );
    const deletedUploads = await prisma.$executeRawUnsafe(
      `DELETE FROM cw_uploads WHERE status IN ('COMPLETED','FAILED','CANCELLED') AND created_at < NOW() - ($1 || ' days')::INTERVAL`,
      String(uploadsDays),
    );
    // Best-effort: delete files after the DB rows are gone so a partial failure on disk
    // doesn't block the next cleanup run from retrying.
    let deletedFiles = 0;
    for (const { blob_name } of expiredUploads) {
      await deleteFile(blob_name).catch(() => {});
      deletedFiles++;
    }

    // Orphan sweep: find files on disk that have no matching cw_uploads row.
    // blobName is stored as a relative path (e.g. "uploads/2026-08-23/uuid.csv"),
    // so we walk the directory recursively and compare relative paths against the DB.
    // Only touch files older than uploadsDays to avoid racing with active uploads.
    // Files are processed in chunks to avoid accumulating all paths in memory at once.
    let orphanFiles = 0;
    try {
      const uploadDir = env().CATWORLD_UPLOAD_DIR;
      const { readdir, stat, unlink } = await import("node:fs/promises");
      const { resolve, relative } = await import("node:path");
      const cutoff = Date.now() - uploadsDays * 24 * 60 * 60 * 1000;
      const CHUNK = 500;
      let chunkBuf: string[] = [];

      // Streaming walk — processes each file in chunks without accumulating all paths
      async function walkAndProcess(dir: string): Promise<void> {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const abs = resolve(dir, entry.name);
          if (entry.isDirectory()) {
            await walkAndProcess(abs);
          } else if (entry.isFile()) {
            const s = await stat(abs).catch(() => null);
            if (!s || s.mtimeMs >= cutoff) continue;
            chunkBuf.push(relative(uploadDir, abs));
            if (chunkBuf.length >= CHUNK) {
              orphanFiles += await deleteOrphansChunk(chunkBuf, uploadDir);
              chunkBuf = [];
            }
          }
        }
      }

      async function deleteOrphansChunk(chunk: string[], baseDir: string): Promise<number> {
        const placeholders = chunk.map((_, j) => `$${j + 1}`).join(",");
        const knownRows = await prisma.$queryRawUnsafe<{ blob_name: string }[]>(
          `SELECT blob_name FROM cw_uploads WHERE blob_name IN (${placeholders})`,
          ...chunk,
        );
        const known = new Set(knownRows.map(r => r.blob_name));
        let count = 0;
        for (const rel of chunk) {
          if (!known.has(rel)) {
            await unlink(resolve(baseDir, rel)).catch(() => {});
            count++;
          }
        }
        return count;
      }

      await walkAndProcess(uploadDir);
      // flush remaining
      if (chunkBuf.length > 0) {
        orphanFiles += await deleteOrphansChunk(chunkBuf, uploadDir);
      }
    } catch { /* best-effort — don't let orphan sweep fail the whole cleanup */ }

    // Para dataset_versions: mantém apenas os últimos N por table_id
    const deletedVersions = await prisma.$executeRawUnsafe(
      `DELETE FROM cw_dataset_versions
       WHERE id IN (
         SELECT id FROM (
           SELECT id, ROW_NUMBER() OVER (PARTITION BY table_id ORDER BY created_at DESC) AS rn
           FROM cw_dataset_versions
         ) ranked
         WHERE rn > $1
       )`,
      versionsKeep,
    );

    const durationMs = Date.now() - t0;
    console.log(
      "[METADATA_CLEANUP] jobs=%d audit_events=%d uploads=%d (files=%d orphans=%d) dataset_versions=%d duration=%dms",
      deletedJobs, deletedAudit, deletedUploads, deletedFiles, orphanFiles, deletedVersions, durationMs,
    );

    // Persiste resultado e atualiza timestamp do último cleanup
    if (runId) {
      await prisma.$executeRawUnsafe(
        `UPDATE cw_cleanup_runs
         SET finished_at=NOW(), duration_ms=$2,
             deleted_jobs=$3, deleted_audit=$4, deleted_uploads=$5,
             deleted_files=$6, deleted_orphans=$7, deleted_versions=$8
         WHERE id=$1::uuid`,
        runId,
        durationMs,
        Number(deletedJobs),
        Number(deletedAudit),
        Number(deletedUploads),
        deletedFiles,
        orphanFiles,
        Number(deletedVersions),
      );
    }
    await prisma.$executeRawUnsafe(
      `INSERT INTO cw_system_settings (key, value, updated_at) VALUES ('cleanup.last_run_at', NOW()::text, NOW())
       ON CONFLICT (key) DO UPDATE SET value = NOW()::text, updated_at = NOW()`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (runId) {
      await prisma.$executeRawUnsafe(
        `UPDATE cw_cleanup_runs SET finished_at=NOW(), duration_ms=$2, error=$3 WHERE id=$1::uuid`,
        runId, Date.now() - t0, msg,
      ).catch(() => {});
    }
    throw e;
  }
}

/** Recurso afetado pelo job, para a trilha de auditoria (id da fonte/derivada/upload; nunca o payload inteiro). */
function jobResource(job: Claimed): { resourceType?: string; resourceId?: string | null } {
  if (job.upload_id) return { resourceType: "upload", resourceId: job.upload_id };
  try {
    const p = job.payload_json ? (JSON.parse(job.payload_json) as Record<string, unknown>) : {};
    if (typeof p.datasetSourceId === "string") return { resourceType: "dataset_source", resourceId: p.datasetSourceId };
    if (typeof p.derivedTableId === "string") return { resourceType: "derived_table", resourceId: p.derivedTableId };
  } catch {
    // payload invalido: cai no id do job
  }
  return {};
}

async function work(job: Claimed) {
  if (job.type === "METADATA_CLEANUP") {
    const hb = startHeartbeat(job.id);
    try {
      await runMetadataCleanup();
    } finally {
      clearInterval(hb);
    }
    await prisma.job.update({ where: { id: job.id }, data: { status: "COMPLETED", lockedAt: null, lockedBy: null, heartbeatAt: null, lastError: null } });
    return;
  }

  if (job.type === "SOURCE_REFRESH") {
    const payload = JSON.parse(job.payload_json ?? "{}") as { datasetSourceId?: string; reconciliation?: boolean };
    if (!payload.datasetSourceId) throw new Error("SOURCE_REFRESH sem datasetSourceId");
    const hb = startHeartbeat(job.id);
    try {
      await refreshDatasetSource(payload.datasetSourceId, { reconciliation: !!payload.reconciliation });
    } finally {
      clearInterval(hb);
    }
    await prisma.job.update({ where: { id: job.id }, data: { status: "COMPLETED", lockedAt: null, lockedBy: null, heartbeatAt: null, lastError: null } });
    return;
  }

  if (job.type === "DERIVED_REFRESH") {
    const payload = JSON.parse(job.payload_json ?? "{}") as { derivedTableId?: string };
    if (!payload.derivedTableId) throw new Error("DERIVED_REFRESH sem derivedTableId");
    const hb = startHeartbeat(job.id);
    try {
      await refreshDerivedTable(payload.derivedTableId);
    } finally {
      clearInterval(hb);
    }
    await prisma.job.update({ where: { id: job.id }, data: { status: "COMPLETED", lockedAt: null, lockedBy: null, heartbeatAt: null, lastError: null } });
    return;
  }

  if (!job.upload_id) throw new Error("Job sem upload");

  const upload = await prisma.upload.findUniqueOrThrow({ where: { id: job.upload_id } });

  // Guard: skip if already COMPLETED or FAILED (cancelled/re-queued after success)
  if (upload.status === "COMPLETED" || upload.status === "FAILED") {
    console.log(`[worker] upload ${upload.id} já está ${upload.status}, pulando job`);
    await prisma.job.update({ where: { id: job.id }, data: { status: "COMPLETED", lockedAt: null, lockedBy: null, heartbeatAt: null, lastError: null } });
    return;
  }

  // BUG6-fix: if recoverStale re-queued a stale job while the original worker is still
  // running, two workers may claim the same upload concurrently. Guard by checking that
  // no OTHER RUNNING job for this upload exists (besides the one we just claimed).
  if (job.type === "IMPORT_UPLOAD" && upload.status === "IMPORTING") {
    const otherRunning = await prisma.job.findFirst({
      where: { uploadId: job.upload_id, status: "RUNNING", id: { not: job.id } },
    });
    if (otherRunning) {
      console.warn(`[worker] upload ${upload.id} já está sendo processado por outro job ${otherRunning.id}, pulando`);
      await prisma.job.update({ where: { id: job.id }, data: { status: "COMPLETED", lockedAt: null, lockedBy: null, heartbeatAt: null, lastError: null } });
      return;
    }
  }

  const heartbeat = startHeartbeat(job.id);

  try {
    if (job.type === "PREVIEW_UPLOAD") {
      const file = await localFile(upload);
      try {
        await prisma.upload.update({ where: { id: upload.id }, data: { status: "PREVIEWING", progress: 10 } });
        const preview = await previewFile(file.path);
        const overrides = upload.typeOverridesJson ? JSON.parse(upload.typeOverridesJson) as Record<string, string> : null;
        const { applied, ignored } = applyTypeOverrides(preview.columns, overrides);
        if (applied.length) console.log("[worker] type overrides aplicados upload=%s: %s", upload.id, applied.join(", "));
        if (ignored.length) console.warn("[worker] type overrides ignorados (coluna ou tipo inválido) upload=%s: %s", upload.id, ignored.join(", "));
        await prisma.upload.update({
          where: { id: upload.id },
          data: { previewJson: JSON.stringify(preview), rowCount: BigInt(preview.rowCount) },
        });
        await queueImportUploadAuto(upload.id, preview.columns);
      } finally {
        await rm(file.dir, { recursive: true, force: true });
      }
    } else if (job.type === "IMPORT_UPLOAD") {
      await prisma.upload.update({ where: { id: upload.id }, data: { status: "IMPORTING", progress: 35 } });
      // Always download to disk so rowsFromFile uses DuckDB server-side (same parser as client preview).
      // This prevents csv-parse quote-handling discrepancies from dropping rows at end of file.
      const file = await localOriginals(upload);
      try {
        await importUpload(upload.id, file.path);
      } finally {
        await rm(file.dir, { recursive: true, force: true });
      }
    } else {
      throw new Error(`Tipo de job desconhecido: ${job.type}`);
    }

    await prisma.job.update({ where: { id: job.id }, data: { status: "COMPLETED", lockedAt: null, lockedBy: null, heartbeatAt: null, lastError: null } });
    // Only delete the upload file after the import is fully done — not after preview
    if (job.type === "IMPORT_UPLOAD") {
      await deleteFile(upload.blobName).catch(() => {});
    }
  } finally {
    clearInterval(heartbeat);
  }
}

async function fail(job: Claimed, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const retry = job.attempts < job.max_attempts;

  // Try to restore rowCount from previewJson when it was zeroed by a failed import
  let restoreRowCount: bigint | undefined;
  if (job.upload_id) {
    try {
      const u = await prisma.upload.findUnique({ where: { id: job.upload_id }, select: { rowCount: true, previewJson: true } });
      if (u && u.previewJson && !Number(u.rowCount)) {
        const pv: FilePreview = JSON.parse(u.previewJson);
        if (pv.rowCount > 0) restoreRowCount = BigInt(pv.rowCount);
      }
    } catch { /* ignore */ }
  }

  const nextRefreshAt = await nextRefreshAtOnFailure(job, retry);
  const sourceFailureUpdate = sourceRefreshFailureUpdate(job, message, retry, nextRefreshAt);
  const derivedFailureUpdate = derivedRefreshFailureUpdate(job, message, retry, nextRefreshAt);

  await prisma.$transaction([
    prisma.job.update({
      where: { id: job.id },
      data: {
        status: retry ? "QUEUED" : "FAILED",
        lastError: message,
        availableAt: new Date(Date.now() + Math.min(job.attempts * 30000, 120000)),
        lockedAt: null,
        lockedBy: null,
        heartbeatAt: null,
      },
    }),
    ...(job.upload_id ? [
      prisma.upload.update({
        where: { id: job.upload_id },
        data: {
          status: retry ? "RETRYING" : "FAILED",
          errorMessage: message,
          ...(restoreRowCount !== undefined ? { rowCount: restoreRowCount } : {}),
        },
      }),
    ] : []),
    ...(sourceFailureUpdate ? [sourceFailureUpdate] : []),
    ...(derivedFailureUpdate ? [derivedFailureUpdate] : []),
  ]);

  if (restoreRowCount !== undefined) console.log("[FAIL] rowCount=0 → restored %d from previewJson", restoreRowCount);
  console.error("[FAIL] upload=%s attempt=%d/%d error=%s", job.upload_id, job.attempts, job.max_attempts, message);
  const sqlError = error as Error & { number?: number; state?: string };
  if (error instanceof Error && sqlError.number) console.error("[FAIL] sqlNumber=%d sqlState=%s", sqlError.number, sqlError.state ?? "");
}

// Em falha final (retry=false), nextRefreshAt precisa avancar pro proximo horario do
// cron — senao a fonte/tabela derivada fica "due" pra sempre e enqueueDue* a
// recoloca na fila a cada poll do worker, gerando um retry-loop infinito (ja
// aconteceu em producao: tabela derivada com SQL quebrado sendo re-tentada a
// cada ~1min por dias). Em retry (ainda ha tentativas), nextRefreshAt fica intacto.
// Continuam sincronas (so retornam o PrismaPromise, sem await interno) para nao
// quebrar a inferencia de overload de prisma.$transaction([...]) mais abaixo —
// quem precisa buscar o refreshCron faz isso antes, em nextRefreshAtOnFailure.
async function nextRefreshAtOnFailure(job: Claimed, retry: boolean): Promise<Date | null | undefined> {
  if (retry) return undefined;
  try {
    if (job.type === "SOURCE_REFRESH") {
      const { datasetSourceId, reconciliation } = JSON.parse(job.payload_json ?? "{}") as { datasetSourceId?: string; reconciliation?: boolean };
      if (!datasetSourceId) return undefined;
      const source = await prisma.datasetSource.findUnique({ where: { id: datasetSourceId }, select: { refreshCron: true, reconciliationCron: true } });
      return nextRefreshFromCron(reconciliation ? source?.reconciliationCron : source?.refreshCron);
    }
    if (job.type === "DERIVED_REFRESH") {
      const { derivedTableId } = JSON.parse(job.payload_json ?? "{}") as { derivedTableId?: string };
      if (!derivedTableId) return undefined;
      const dt = await prisma.derivedTable.findUnique({ where: { id: derivedTableId }, select: { refreshCron: true } });
      return nextRefreshFromCron(dt?.refreshCron);
    }
  } catch { /* payload malformado — deixa nextRefreshAt intacto */ }
  return undefined;
}

function sourceRefreshFailureUpdate(job: Claimed, message: string, retry: boolean, nextRefreshAt: Date | null | undefined) {
  if (job.type !== "SOURCE_REFRESH") return null;
  let payload: { datasetSourceId?: string; reconciliation?: boolean };
  try {
    payload = JSON.parse(job.payload_json ?? "{}") as { datasetSourceId?: string; reconciliation?: boolean };
  } catch {
    return null;
  }
  if (!payload.datasetSourceId) return null;
  return prisma.datasetSource.updateMany({
    where: { id: payload.datasetSourceId },
    data: {
      lastStatus: retry ? "queued" : "failed",
      lastError: message,
      ...(payload.reconciliation ? { nextReconciliationAt: nextRefreshAt } : { nextRefreshAt }),
    },
  });
}

function derivedRefreshFailureUpdate(job: Claimed, message: string, retry: boolean, nextRefreshAt: Date | null | undefined) {
  if (job.type !== "DERIVED_REFRESH") return null;
  let payload: { derivedTableId?: string };
  try {
    payload = JSON.parse(job.payload_json ?? "{}") as { derivedTableId?: string };
  } catch {
    return null;
  }
  if (!payload.derivedTableId) return null;
  return prisma.derivedTable.updateMany({
    where: { id: payload.derivedTableId },
    data: {
      lastStatus: retry ? "queued" : "failed",
      lastError: message,
      nextRefreshAt,
    },
  });
}

async function recoverStale() {
  // Mark stale RUNNING jobs that exceeded max attempts as FAILED.
  // Imports can legitimately spend several minutes inside Azure SQL/Bulk APIs,
  // so they get a longer stale window than preview/lightweight jobs.
  await prisma.$executeRawUnsafe(
    `UPDATE cw_jobs
     SET status='FAILED', locked_at=NULL, locked_by=NULL, heartbeat_at=NULL,
         last_error='Worker crashed (stale heartbeat, max attempts reached)'
     WHERE status='RUNNING'
       AND heartbeat_at < CASE
         WHEN type='IMPORT_UPLOAD' THEN NOW() - INTERVAL '90 minutes'
         ELSE NOW() - INTERVAL '120 seconds'
       END
       AND attempts >= max_attempts`,
  );

  // Re-queue stale RUNNING jobs that still have retries left
  await prisma.$executeRawUnsafe(
    `UPDATE cw_jobs
     SET status='QUEUED', locked_at=NULL, locked_by=NULL, heartbeat_at=NULL, available_at=NOW()
     WHERE status='RUNNING'
       AND heartbeat_at < CASE
         WHEN type='IMPORT_UPLOAD' THEN NOW() - INTERVAL '90 minutes'
         ELSE NOW() - INTERVAL '120 seconds'
       END
       AND attempts < max_attempts`,
  );

  // Fix IMPORTING uploads whose all jobs are now FAILED (no active job left)
  await prisma.$executeRawUnsafe(
    `UPDATE cw_uploads
     SET status='FAILED', error_message='Import interrompido (jobs esgotados)', updated_at=NOW()
     WHERE status='IMPORTING'
       AND NOT EXISTS (
         SELECT 1 FROM cw_jobs j
         WHERE j.upload_id=cw_uploads.id AND j.status IN ('QUEUED','RUNNING','COMPLETED')
       )`,
  );

  await prisma.$executeRawUnsafe(
    `UPDATE cw_dataset_sources
     SET last_status='failed',
         last_error='Processamento interrompido',
         next_refresh_at=CASE
           WHEN refresh_cron IS NOT NULL THEN NOW() + INTERVAL '10 minutes'
           ELSE NULL
         END,
         updated_at=NOW()
     WHERE last_status='running'
       AND NOT EXISTS (
         SELECT 1
         FROM cw_jobs j
         WHERE j.type='SOURCE_REFRESH'
           AND j.status IN ('QUEUED','RUNNING')
           AND j.payload_json::jsonb->>'datasetSourceId' = cw_dataset_sources.id::text
       )`,
  );

  // Fix derived tables stuck in 'running' with no active job
  await prisma.$executeRawUnsafe(
    `UPDATE cw_derived_tables
     SET last_status='failed',
         last_error='Processamento interrompido',
         updated_at=NOW()
     WHERE last_status='running'
       AND NOT EXISTS (
         SELECT 1
         FROM cw_jobs j
         WHERE j.type='DERIVED_REFRESH'
           AND j.status IN ('QUEUED','RUNNING')
           AND j.payload_json::jsonb->>'derivedTableId' = cw_derived_tables.id::text
       )`,
  );
}

async function loop(concurrencyId: number) {
  const workerLabel = `${profile.name}-${concurrencyId}@${hostname()}`;
  const allowedTypes = [...profile.jobTypes];
  console.log(`[worker] ${workerLabel} tipos: ${allowedTypes.join(", ")}`);
  while (state.canClaim) {
    let job: Claimed | null;
    try {
      const { getWorkerConfig } = await import("@/server/worker/config");
      const { maxHeavyJobs, maxSyncsPerStorage } = await getWorkerConfig();
      job = await claim(workerLabel, maxHeavyJobs, maxSyncsPerStorage, allowedTypes);
    } catch (e) {
      console.warn("[worker] claim falhou (transiente): %s", e instanceof Error ? e.message : e);
      await nap(profile.pollMs);
      continue;
    }
    if (!job) {
      await nap(profile.pollMs);
      continue;
    }
    state.jobStarted();
    try {
    // Camada 1 (auditoria) — nao influencia nenhuma decisao de agendamento,
    // so grava custo real por job em cw_job_metrics.
    const rssBefore = currentRssMb();
    const t0 = Date.now();
    let fileSizeBytes: bigint | null = null;
    if (job.upload_id) {
      fileSizeBytes = await prisma.upload.findUnique({ where: { id: job.upload_id }, select: { sizeBytes: true } })
        .then(u => u?.sizeBytes ?? null).catch(() => null);
    }
    try {
      await work(job);
      await recordJobMetric({
        jobId: job.id, jobType: job.type, status: "COMPLETED", weight: job.weight,
        fileSizeBytes, rssBeforeMb: rssBefore, rssAfterMb: currentRssMb(),
        durationMs: Date.now() - t0, workerLabel,
      });
      await auditJob({ jobId: job.id, jobType: job.type, success: true, workerLabel, durationMs: Date.now() - t0, attempts: job.attempts, ...jobResource(job) });
    } catch (e) {
      await recordJobMetric({
        jobId: job.id, jobType: job.type, status: "FAILED", weight: job.weight,
        fileSizeBytes, rssBeforeMb: rssBefore, rssAfterMb: currentRssMb(),
        durationMs: Date.now() - t0, workerLabel,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      await auditJob({
        jobId: job.id, jobType: job.type, success: false, workerLabel, durationMs: Date.now() - t0, attempts: job.attempts,
        willRetry: job.attempts < job.max_attempts, error: e instanceof Error ? e.message : String(e), ...jobResource(job),
      });
      try {
        await fail(job, e);
      } catch (fe) {
        // fail() pode lançar se o DB estiver fora. Loga mas não deixa o loop morrer.
        console.error("[worker] fail() lançou (DB indisponível?): %s", fe instanceof Error ? fe.message : fe);
      }
    }
    } finally {
      state.jobFinished();
    }
  }
}

async function releaseSelf() {
  const workerId = profile.name;
  const concurrency = profile.concurrency;
  // Match worker-N-1@hostname, worker-N-2@hostname, etc. Parametrizado; '_' e '%' do id nao viram curinga do LIKE.
  const escaped = workerId.replace(/[\\%_]/g, (c) => `\\${c}`);
  const labels = Array.from({ length: concurrency }, (_, i) => `${workerId}-${i + 1}`);
  const likes = labels.map((_, i) => `${escaped}-${i + 1}@%`);
  const released = await prisma.$executeRawUnsafe(
    `UPDATE cw_jobs
     SET status='QUEUED', locked_at=NULL, locked_by=NULL, heartbeat_at=NULL, available_at=NOW()
     WHERE status='RUNNING' AND (locked_by LIKE ANY($1::text[]) OR locked_by = ANY($2::text[]))`,
    likes,
    labels,
  );
  if (released > 0) console.log(`[worker] startup: ${released} job(s) do worker anterior liberados`);
}

/** Sai com mensagem clara (nunca sobe sem perfil): 2 = perfil ausente/inexistente, 3 = identidade em uso, 4 = desabilitado. */
async function bootstrapProfile(): Promise<WorkerProfileRow> {
  env(); // valida a infraestrutura e avisa (uma vez) sobre envs de worker legadas, que são ignoradas
  const name = parseProfileArg(process.argv);
  if (!name) {
    const names = await listProfileNames().catch(() => []);
    console.error(`[worker] informe o perfil: --profile <nome>. Perfis cadastrados: ${names.join(", ") || "(nenhum)"}. Crie/edite em Configurações > Worker ou use o supervisor (npm run supervisor).`);
    process.exit(2);
  }
  const p = await loadProfile(name).catch((e) => { console.error("[worker] falha ao ler o perfil:", e instanceof Error ? e.message : e); return null; });
  if (!p) {
    const names = await listProfileNames().catch(() => []);
    console.error(`[worker] perfil "${name}" não existe. Perfis cadastrados: ${names.join(", ") || "(nenhum)"}.`);
    process.exit(2);
  }
  if (!p.enabled) {
    console.error(`[worker] perfil "${name}" está desabilitado (habilite em Configurações > Worker).`);
    process.exit(4);
  }
  const live = await readWorkerLiveness(p.name).catch(() => undefined);
  if (identityConflict(live, { host: hostname(), pid: process.pid }, Date.now(), isPidAlive)) {
    console.error(`[worker] já existe outro processo ativo com o perfil "${p.name}" (pulsação recente). Pare o serviço antigo antes de subir este.`);
    process.exit(3);
  }
  return p;
}

/** Relê o perfil: poll e memória valem na hora; tipos/concorrência só no próximo reinício; desabilitar drena. */
async function refreshProfile() {
  const fresh = await loadProfile(profile.name).catch(() => null);
  if (!fresh) return; // banco fora do ar (ou perfil apagado): segue com o que tem; o supervisor decide
  if (!fresh.enabled) { console.log("[worker] perfil desabilitado: drenando"); state.draining = true; }
  if (fresh.pollMs !== profile.pollMs) profile.pollMs = fresh.pollMs;
  if (fresh.duckdbMemoryLimit !== profile.duckdbMemoryLimit) {
    profile.duckdbMemoryLimit = fresh.duckdbMemoryLimit;
    setDuckdbMemoryLimit(fresh.duckdbMemoryLimit);
  }
  profile.revision = fresh.revision;
}

async function main() {
  profile = await bootstrapProfile();
  setDuckdbMemoryLimit(profile.duckdbMemoryLimit);
  const concurrency = profile.concurrency;
  console.log(`Catworld worker ${profile.name} iniciado (concorrência: ${concurrency})`);
  await releaseSelf();
  const allowedTypes = profile.jobTypes;
  const handlesSourceRefresh = allowedTypes.includes("SOURCE_REFRESH");
  const handlesDerivedRefresh = allowedTypes.includes("DERIVED_REFRESH");
  const handlesCleanup = allowedTypes.includes("METADATA_CLEANUP");

  // Enqueue one METADATA_CLEANUP per day if none is queued/running.
  // Usa cw_system_settings para rastrear o último cleanup — não cw_jobs, que se auto-deleta.
  // O INSERT é atômico (WHERE NOT EXISTS) para evitar race condition com múltiplos workers.
  async function scheduleCleanupIfNeeded() {
    if (!handlesCleanup) return;
    const settingRows = await prisma.$queryRawUnsafe<{ value: string }[]>(
      `SELECT value FROM cw_system_settings WHERE key = 'cleanup.last_run_at'`,
    );
    const lastRunAt = settingRows[0] ? new Date(settingRows[0].value).getTime() : 0;
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    if (lastRunAt > dayAgo) return; // cleanup recente, não precisa agendar
    const inserted = await prisma.$executeRawUnsafe(
      `INSERT INTO cw_jobs (id, type, status, payload_json, attempts, max_attempts, weight, available_at, created_at, updated_at)
       SELECT gen_random_uuid(), 'METADATA_CLEANUP', 'QUEUED', NULL, 0, 1, 0, NOW(), NOW(), NOW()
       WHERE NOT EXISTS (
         SELECT 1 FROM cw_jobs WHERE type = 'METADATA_CLEANUP' AND status IN ('QUEUED', 'RUNNING')
       )`,
    );
    if (inserted > 0) console.log("[worker] METADATA_CLEANUP agendado");
  }

  let lastRecovery = 0;
  let lastLiveness = 0;
  let lastProfileRefresh = 0;
  const workerId = profile.name;
  const recoveryLoop = async () => {
    while (!state.finished) {
      // Camada 2: pulsação geral do worker — roda independente de qualquer job
      // específico, consumida pelo HEALTHCHECK do Docker (ver scripts/worker-healthcheck.mjs).
      if (Date.now() - lastLiveness > 15000) {
        await writeWorkerLiveness(workerId, hostname(), process.pid);
        lastLiveness = Date.now();
      }
      if (Date.now() - lastProfileRefresh > 10000) {
        await refreshProfile();
        lastProfileRefresh = Date.now();
      }
      if (Date.now() - lastRecovery > 60000) {
        try {
          await recoverStale();
          if (handlesSourceRefresh) { await enqueueDueSourceRefreshes(); await enqueueDueReconciliations(); }
          if (handlesDerivedRefresh) await enqueueDueDerivedRefreshes();
          await scheduleCleanupIfNeeded();
        } catch (e) {
          console.warn("[recovery] erro (transiente): %s", e instanceof Error ? e.message : e);
        }
        lastRecovery = Date.now();
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  };
  const workers = Array.from({ length: concurrency }, (_, i) => loop(i + 1));
  await Promise.all([recoveryLoop(), ...workers]);
  await clearWorkerLiveness(workerId, hostname(), process.pid);
  await prisma.$disconnect();
  process.exit(0); // com IPC aberto o processo não termina sozinho
}

void main().catch(e => { console.error(e); process.exit(1); });
