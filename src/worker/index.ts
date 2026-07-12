import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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

type Claimed = { id: string; type: string; upload_id: string | null; payload_json: string | null; attempts: number; max_attempts: number; weight: number };

let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });

async function claim(lockedBy: string, maxHeavy: number): Promise<Claimed | null> {
  const rows = await prisma.$queryRawUnsafe<Claimed[]>(
    `DECLARE @job TABLE(id uniqueidentifier,type varchar(50),upload_id uniqueidentifier,payload_json nvarchar(max),attempts int,max_attempts int,weight tinyint);
     UPDATE dbo.cw_jobs WITH (UPDLOCK,READPAST,ROWLOCK)
       SET status='RUNNING',locked_at=SYSUTCDATETIME(),heartbeat_at=SYSUTCDATETIME(),locked_by=@P1,attempts=attempts+1
       OUTPUT inserted.id,inserted.type,inserted.upload_id,inserted.payload_json,inserted.attempts,inserted.max_attempts,inserted.weight INTO @job
     WHERE id=(
       SELECT TOP(1) id FROM dbo.cw_jobs WITH (UPDLOCK,READPAST)
       WHERE status='QUEUED' AND available_at<=SYSUTCDATETIME()
         AND (weight<2 OR (SELECT COUNT(*) FROM dbo.cw_jobs WHERE status='RUNNING' AND weight=2)<@P2)
       ORDER BY weight ASC,available_at ASC
     );
     SELECT * FROM @job`,
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

async function convertLegacy(path: string, dir: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("soffice", ["--headless", "--convert-to", "xlsx", "--outdir", dir, path], { stdio: "ignore" });
    child.on("exit", code => code === 0 ? resolve() : reject(new Error("Falha ao converter XLS legado com LibreOffice")));
    child.on("error", reject);
  });
  return join(dir, `${basename(path, ".xls")}.xlsx`);
}

async function work(job: Claimed) {
  if (job.type === "SOURCE_REFRESH") {
    const payload = JSON.parse(job.payload_json ?? "{}") as { datasetSourceId?: string };
    if (!payload.datasetSourceId) throw new Error("SOURCE_REFRESH sem datasetSourceId");
    await refreshDatasetSource(payload.datasetSourceId);
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
      const ext = extname(upload.originalFilename).toLowerCase();
      const useStream = !!env().CATWORLD_AZURE_BLOB_CONNECTION_STRING && ext !== ".xls";

      if (useStream) {
        // Use originals/ copy (made at upload time, no lifecycle TTL) — fall back to blobName if missing
        let stream: NodeJS.ReadableStream;
        try {
          stream = await downloadFile(`originals/${upload.id}${ext}`);
        } catch {
          stream = await downloadFile(upload.blobName);
        }
        await importUpload(upload.id, stream);
      } else {
        // Local storage or XLS: download to disk first
        const file = await localFile(upload);
        try {
          await importUpload(upload.id, file.path);
        } finally {
          await rm(file.dir, { recursive: true, force: true });
        }
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

async function recoverStale() {
  // Mark stale RUNNING jobs that exceeded max attempts as FAILED.
  // Imports can legitimately spend several minutes inside Azure SQL/Bulk APIs,
  // so they get a longer stale window than preview/lightweight jobs.
  await prisma.$executeRawUnsafe(
    `UPDATE dbo.cw_jobs
     SET status='FAILED', locked_at=NULL, locked_by=NULL, heartbeat_at=NULL,
         last_error='Worker crashed (stale heartbeat, max attempts reached)'
     WHERE status='RUNNING'
       AND heartbeat_at < CASE
         WHEN type='IMPORT_UPLOAD' THEN DATEADD(MINUTE,-90,SYSUTCDATETIME())
         ELSE DATEADD(SECOND,-120,SYSUTCDATETIME())
       END
       AND attempts >= max_attempts`,
  );

  // Re-queue stale RUNNING jobs that still have retries left
  await prisma.$executeRawUnsafe(
    `UPDATE dbo.cw_jobs
     SET status='QUEUED', locked_at=NULL, locked_by=NULL, heartbeat_at=NULL, available_at=SYSUTCDATETIME()
     WHERE status='RUNNING'
       AND heartbeat_at < CASE
         WHEN type='IMPORT_UPLOAD' THEN DATEADD(MINUTE,-90,SYSUTCDATETIME())
         ELSE DATEADD(SECOND,-120,SYSUTCDATETIME())
       END
       AND attempts < max_attempts`,
  );

  // Fix IMPORTING uploads whose all jobs are now FAILED (no active job left)
  await prisma.$executeRawUnsafe(
    `UPDATE u SET u.status='FAILED', u.error_message='Import interrompido (jobs esgotados)', u.updated_at=SYSUTCDATETIME()
     FROM dbo.cw_uploads u
     WHERE u.status='IMPORTING'
       AND NOT EXISTS (
         SELECT 1 FROM dbo.cw_jobs j
         WHERE j.upload_id=u.id AND j.status IN ('QUEUED','RUNNING','COMPLETED')
       )`,
  );

  await prisma.$executeRawUnsafe(
    `UPDATE s
     SET last_status='failed',
         last_error='Processamento interrompido',
         next_refresh_at=CASE
           WHEN s.refresh_policy='hourly' THEN DATEADD(HOUR,1,SYSUTCDATETIME())
           WHEN s.refresh_policy='daily' THEN DATEADD(DAY,1,SYSUTCDATETIME())
           WHEN s.refresh_policy='weekly' THEN DATEADD(DAY,7,SYSUTCDATETIME())
           ELSE NULL
         END,
         updated_at=SYSUTCDATETIME()
     FROM dbo.cw_dataset_sources s
     WHERE s.last_status='running'
       AND NOT EXISTS (
         SELECT 1
         FROM dbo.cw_jobs j
         WHERE j.type='SOURCE_REFRESH'
           AND j.status IN ('QUEUED','RUNNING')
           AND JSON_VALUE(j.payload_json,'$.datasetSourceId') = CONVERT(nvarchar(36),s.id)
       )`,
  );
}

async function loop(concurrencyId: number) {
  const workerLabel = `${env().CATWORLD_WORKER_ID}-${concurrencyId}`;
  console.log(`[worker] ${workerLabel} iniciado`);
  const maxHeavy = env().CATWORLD_MAX_HEAVY_JOBS;
  while (!stopping) {
    const job = await claim(workerLabel, maxHeavy);
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
  const labels = Array.from({ length: concurrency }, (_, i) => `'${workerId}-${i + 1}'`).join(",");
  const released = await prisma.$executeRawUnsafe(
    `UPDATE dbo.cw_jobs
     SET status='QUEUED', locked_at=NULL, locked_by=NULL, heartbeat_at=NULL, available_at=SYSUTCDATETIME()
     WHERE status='RUNNING' AND locked_by IN (${labels})`,
  );
  if (released > 0) console.log(`[worker] startup: ${released} job(s) do worker anterior liberados`);
}

async function main() {
  const concurrency = env().CATWORLD_WORKER_CONCURRENCY;
  console.log(`Catworld worker ${env().CATWORLD_WORKER_ID} iniciado (concorrência: ${concurrency})`);
  await releaseSelf();
  let lastRecovery = 0;
  const recoveryLoop = async () => {
    while (!stopping) {
      if (Date.now() - lastRecovery > 60000) {
        await recoverStale();
        await enqueueDueSourceRefreshes();
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
