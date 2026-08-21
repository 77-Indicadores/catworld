import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { prisma } from "@/server/db";
import { downloadFile, deleteFile, copyFile } from "@/server/storage";
import { env } from "@/server/env";
import { previewFile, type FilePreview } from "@/server/uploads/parser";
import { importUpload } from "@/server/uploads/importer";
import { queueImportUploadAuto } from "@/server/uploads/actions";
import { enqueueDueSourceRefreshes, refreshDatasetSource } from "@/server/connections/sources";
import { enqueueDueDerivedRefreshes, refreshDerivedTable } from "@/server/connections/derived";

type Claimed = { id: string; type: string; upload_id: string | null; payload_json: string | null; attempts: number; max_attempts: number; weight: number };

let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });

async function claim(lockedBy: string, maxHeavy: number, allowedTypes: string[] | null): Promise<Claimed | null> {
  const typeFilter = allowedTypes && allowedTypes.length > 0
    ? `AND type IN (${allowedTypes.map(t => `'${t.replace(/'/g, "''")}'`).join(",")})`
    : "";
  const rows = await prisma.$queryRawUnsafe<Claimed[]>(
    `UPDATE cw_jobs
     SET status='RUNNING',locked_at=NOW(),heartbeat_at=NOW(),locked_by=$1,attempts=attempts+1
     WHERE id=(
       SELECT id FROM cw_jobs
       WHERE status='QUEUED' AND available_at<=NOW()
         ${typeFilter}
         AND (weight<2 OR (SELECT COUNT(*) FROM cw_jobs WHERE status='RUNNING' AND weight=2)<$2)
       ORDER BY weight ASC,available_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id,type,upload_id,payload_json,attempts,max_attempts,weight`,
    lockedBy,
    maxHeavy,
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

// Downloads from originals/ (falling back to blobName) to a temp file so the import
// uses the DuckDB server-side path — same parser as the client-side preview.
async function localOriginals(upload: { id: string; blobName: string; originalFilename: string }) {
  const ext = extname(upload.originalFilename).toLowerCase();
  const dir = await mkdtemp(join(tmpdir(), "catworld-"));
  const path = join(dir, basename(upload.originalFilename));
  let stream: NodeJS.ReadableStream;
  try {
    stream = await downloadFile(`originals/${upload.id}${ext}`);
  } catch {
    stream = await downloadFile(upload.blobName);
  }
  await pipeline(stream, createWriteStream(path));
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
  // Lê configurações de retenção do Postgres via SQL direto (evita dependência do Prisma client gerado)
  const rows = await prisma.$queryRawUnsafe<{ key: string; value: string }[]>(
    `SELECT key, value FROM cw_system_settings WHERE key = ANY($1::text[])`,
    ["retention.jobs_days", "retention.audit_events_days", "retention.uploads_days", "retention.dataset_versions_keep"],
  );
  const cfg = Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]));
  const jobsDays            = cfg["retention.jobs_days"]             ?? 30;
  const auditDays           = cfg["retention.audit_events_days"]     ?? 30;
  const uploadsDays         = cfg["retention.uploads_days"]          ?? 30;
  const versionsKeep        = cfg["retention.dataset_versions_keep"] ?? 10;

  const deletedJobs = await prisma.$executeRawUnsafe(
    `DELETE FROM cw_jobs WHERE status IN ('COMPLETED','FAILED') AND created_at < NOW() - ($1 || ' days')::INTERVAL`,
    String(jobsDays),
  );

  const deletedAudit = await prisma.$executeRawUnsafe(
    `DELETE FROM cw_audit_events WHERE created_at < NOW() - ($1 || ' days')::INTERVAL`,
    String(auditDays),
  );

  const deletedUploads = await prisma.$executeRawUnsafe(
    `DELETE FROM cw_uploads WHERE status IN ('COMPLETED','FAILED','CANCELLED') AND created_at < NOW() - ($1 || ' days')::INTERVAL`,
    String(uploadsDays),
  );

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

  console.log(
    "[METADATA_CLEANUP] jobs=%d audit_events=%d uploads=%d dataset_versions=%d",
    deletedJobs, deletedAudit, deletedUploads, deletedVersions,
  );
}

async function work(job: Claimed) {
  if (job.type === "METADATA_CLEANUP") {
    await runMetadataCleanup();
    await prisma.job.update({ where: { id: job.id }, data: { status: "COMPLETED", lockedAt: null, lockedBy: null, heartbeatAt: null, lastError: null } });
    return;
  }

  if (job.type === "SOURCE_REFRESH") {
    const payload = JSON.parse(job.payload_json ?? "{}") as { datasetSourceId?: string };
    if (!payload.datasetSourceId) throw new Error("SOURCE_REFRESH sem datasetSourceId");
    const hb = setInterval(
      () => prisma.job.update({ where: { id: job.id }, data: { heartbeatAt: new Date() } }).catch(
        (e) => console.warn("[heartbeat] falhou job=%s: %s", job.id, e instanceof Error ? e.message : e)
      ),
      15000,
    );
    try {
      await refreshDatasetSource(payload.datasetSourceId);
    } finally {
      clearInterval(hb);
    }
    await prisma.job.update({ where: { id: job.id }, data: { status: "COMPLETED", lockedAt: null, lockedBy: null, heartbeatAt: null, lastError: null } });
    return;
  }

  if (job.type === "DERIVED_REFRESH") {
    const payload = JSON.parse(job.payload_json ?? "{}") as { derivedTableId?: string };
    if (!payload.derivedTableId) throw new Error("DERIVED_REFRESH sem derivedTableId");
    const hb = setInterval(
      () => prisma.job.update({ where: { id: job.id }, data: { heartbeatAt: new Date() } }).catch(
        (e) => console.warn("[heartbeat] falhou job=%s: %s", job.id, e instanceof Error ? e.message : e)
      ),
      15000,
    );
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

  const heartbeat = setInterval(
    () => prisma.job.update({ where: { id: job.id }, data: { heartbeatAt: new Date() } }).catch(
      (e) => console.warn("[heartbeat] falhou job=%s: %s", job.id, e instanceof Error ? e.message : e)
    ),
    15000,
  );

  try {
    if (job.type === "PREVIEW_UPLOAD") {
      const file = await localFile(upload);
      try {
        await prisma.upload.update({ where: { id: upload.id }, data: { status: "PREVIEWING", progress: 10 } });
        // Blob is provably alive (just downloaded). Copy to originals/ so IMPORT_UPLOAD is guaranteed a source.
        const ext = extname(upload.originalFilename).toLowerCase();
        await copyFile(upload.blobName, `originals/${upload.id}${ext}`).catch((e) => {
          console.error("[PREVIEW] originals/ copy failed for", upload.id, e instanceof Error ? e.message : e);
        });
        const preview = await previewFile(file.path);
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
    // Only delete blobs after the import is fully done — not after preview
    if (job.type === "IMPORT_UPLOAD") {
      await deleteFile(upload.blobName).catch(() => {});
      const ext = extname(upload.originalFilename).toLowerCase();
      await deleteFile(`originals/${upload.id}${ext}`).catch(() => {});
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

  const sourceFailureUpdate = sourceRefreshFailureUpdate(job, message, retry);
  const derivedFailureUpdate = derivedRefreshFailureUpdate(job, message, retry);

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

function sourceRefreshFailureUpdate(job: Claimed, message: string, retry: boolean) {
  if (job.type !== "SOURCE_REFRESH") return null;
  let payload: { datasetSourceId?: string };
  try {
    payload = JSON.parse(job.payload_json ?? "{}") as { datasetSourceId?: string };
  } catch {
    return null;
  }
  if (!payload.datasetSourceId) return null;
  return prisma.datasetSource.updateMany({
    where: { id: payload.datasetSourceId },
    data: {
      lastStatus: retry ? "queued" : "failed",
      lastError: message,
      nextRefreshAt: retry ? undefined : new Date(),
    },
  });
}

function derivedRefreshFailureUpdate(job: Claimed, message: string, retry: boolean) {
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
  const workerLabel = `${env().CATWORLD_WORKER_ID}-${concurrencyId}@${hostname()}`;
  const rawTypes = env().CATWORLD_WORKER_JOB_TYPES;
  const allowedTypes = rawTypes ? rawTypes.split(",").map(t => t.trim()).filter(Boolean) : null;
  if (allowedTypes) console.log(`[worker] ${workerLabel} restrito a tipos: ${allowedTypes.join(", ")}`);
  else console.log(`[worker] ${workerLabel} iniciado`);
  const maxHeavy = env().CATWORLD_MAX_HEAVY_JOBS;
  while (!stopping) {
    let job: Claimed | null;
    try {
      job = await claim(workerLabel, maxHeavy, allowedTypes);
    } catch (e) {
      console.warn("[worker] claim falhou (transiente): %s", e instanceof Error ? e.message : e);
      await new Promise(r => setTimeout(r, env().CATWORLD_JOB_POLL_MS));
      continue;
    }
    if (!job) {
      await new Promise(r => setTimeout(r, env().CATWORLD_JOB_POLL_MS));
      continue;
    }
    try {
      await work(job);
    } catch (e) {
      await fail(job, e);
    }
  }
}

async function releaseSelf() {
  const workerId = env().CATWORLD_WORKER_ID;
  const concurrency = env().CATWORLD_WORKER_CONCURRENCY;
  // Match worker-N-1@hostname, worker-N-2@hostname, etc. — LIKE handles the @hostname suffix.
  const likeConditions = Array.from(
    { length: concurrency },
    (_, i) => `locked_by LIKE '${workerId}-${i + 1}@%' OR locked_by='${workerId}-${i + 1}'`,
  ).join(" OR ");
  const released = await prisma.$executeRawUnsafe(
    `UPDATE cw_jobs
     SET status='QUEUED', locked_at=NULL, locked_by=NULL, heartbeat_at=NULL, available_at=NOW()
     WHERE status='RUNNING' AND (${likeConditions})`,
  );
  if (released > 0) console.log(`[worker] startup: ${released} job(s) do worker anterior liberados`);
}

async function main() {
  const concurrency = env().CATWORLD_WORKER_CONCURRENCY;
  console.log(`Catworld worker ${env().CATWORLD_WORKER_ID} iniciado (concorrência: ${concurrency})`);
  await releaseSelf();
  const rawTypes = env().CATWORLD_WORKER_JOB_TYPES;
  const allowedTypes = rawTypes ? rawTypes.split(",").map(t => t.trim()).filter(Boolean) : null;
  const handlesSourceRefresh = !allowedTypes || allowedTypes.includes("SOURCE_REFRESH");
  const handlesDerivedRefresh = !allowedTypes || allowedTypes.includes("DERIVED_REFRESH");
  const handlesCleanup = !allowedTypes || allowedTypes.includes("METADATA_CLEANUP");

  // Enqueue one METADATA_CLEANUP per day if none is queued/running
  async function scheduleCleanupIfNeeded() {
    if (!handlesCleanup) return;
    const existing = await prisma.job.findFirst({
      where: { type: "METADATA_CLEANUP", status: { in: ["QUEUED", "RUNNING"] } },
    });
    if (existing) return;
    const last = await prisma.job.findFirst({
      where: { type: "METADATA_CLEANUP", status: "COMPLETED" },
      orderBy: { createdAt: "desc" },
    });
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    if (!last || last.createdAt.getTime() < dayAgo) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO cw_jobs (id, type, status, payload_json, attempts, max_attempts, weight, available_at, created_at, updated_at)
         VALUES (gen_random_uuid(), 'METADATA_CLEANUP', 'QUEUED', NULL, 0, 1, 0, NOW(), NOW(), NOW())`,
      );
      console.log("[worker] METADATA_CLEANUP agendado");
    }
  }

  let lastRecovery = 0;
  const recoveryLoop = async () => {
    while (!stopping) {
      if (Date.now() - lastRecovery > 60000) {
        try {
          await recoverStale();
          if (handlesSourceRefresh) await enqueueDueSourceRefreshes();
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
  await prisma.$disconnect();
}

void main().catch(e => { console.error(e); process.exitCode = 1; });
