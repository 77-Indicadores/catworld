/**
 * Histórico de uma tabela: versões (cada carga que mudou os dados) e execuções (jobs que a alimentaram).
 * `buildTableHistory` é puro (mescla/ordena/dedup); `loadTableHistory` só busca as linhas.
 *
 * Execuções vêm de `cw_job_metrics` (têm duração e memória; ligadas à tabela por `table_id`, gravado pelo worker a partir
 * desta versão) e, para o que veio ANTES, de `cw_jobs` ainda retidos (30 dias): sem duração.
 */
import { prisma } from "@/server/db";
import { fileExists } from "@/server/storage";

export type HistoryVersion = {
  id: string;
  createdAt: string;
  rowCount: string;
  origin: "upload" | "sync";
  /** `fileAvailable`: o arquivo original ainda está guardado (retenção) e pode ser baixado. */
  upload: { id: string; filename: string; mode: string; createdBy: string | null; sizeBytes: string; fileAvailable: boolean } | null;
};

export type HistoryRun = {
  id: string;
  jobId: string | null;
  kind: string;
  status: string;
  startedAt: string;
  durationMs: number | null;
  rssMb: number | null;
  error: string | null;
};

export type TableHistory = { versions: HistoryVersion[]; runs: HistoryRun[]; runsNote: string | null };

export type VersionRow = { id: string; uploadId: string | null; rowCount: bigint; createdAt: Date };
export type UploadRow = { id: string; originalFilename: string; mode: string; createdBy: string | null; sizeBytes?: bigint; blobName?: string };
export type MetricRow = { id: string; jobId: string; jobType: string; status: string; durationMs: number | null; rssAfterMb: number | null; errorMessage: string | null; createdAt: Date };
export type JobRow = { id: string; type: string; status: string; lastError: string | null; createdAt: Date };

export const HISTORY_LIMIT = 20;

export function buildTableHistory(
  input: { versions: VersionRow[]; uploads: UploadRow[]; metrics: MetricRow[]; jobs: JobRow[]; /** blobNames ainda em disco */ filesOnDisk?: ReadonlySet<string> },
  limit: number = HISTORY_LIMIT,
): TableHistory {
  const uploads = new Map(input.uploads.map((u) => [u.id, u]));
  const versions: HistoryVersion[] = [...input.versions]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit)
    .map((v) => {
      const u = v.uploadId ? uploads.get(v.uploadId) : undefined;
      return {
        id: v.id,
        createdAt: v.createdAt.toISOString(),
        rowCount: String(v.rowCount),
        origin: u ? "upload" : "sync",
        upload: u ? { id: u.id, filename: u.originalFilename, mode: u.mode, createdBy: u.createdBy, sizeBytes: String(u.sizeBytes ?? 0n), fileAvailable: !!u.blobName && !!input.filesOnDisk?.has(u.blobName) } : null,
      };
    });

  const seen = new Set<string>();
  const runs: HistoryRun[] = [];
  for (const m of input.metrics) {
    seen.add(m.jobId);
    runs.push({ id: m.id, jobId: m.jobId, kind: m.jobType, status: m.status, startedAt: m.createdAt.toISOString(), durationMs: m.durationMs, rssMb: m.rssAfterMb, error: m.errorMessage });
  }
  let fallback = 0;
  for (const j of input.jobs) {
    if (seen.has(j.id)) continue;
    fallback++;
    runs.push({ id: j.id, jobId: j.id, kind: j.type, status: j.status, startedAt: j.createdAt.toISOString(), durationMs: null, rssMb: null, error: j.lastError });
  }
  runs.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));

  return {
    versions,
    runs: runs.slice(0, limit),
    runsNote: fallback > 0 ? "Execuções anteriores a esta versão aparecem sem duração nem memória." : null,
  };
}

export async function loadTableHistory(tableId: string, limit: number = HISTORY_LIMIT): Promise<TableHistory> {
  const versions = await prisma.datasetVersion.findMany({ where: { tableId }, orderBy: { createdAt: "desc" }, take: limit, select: { id: true, uploadId: true, rowCount: true, createdAt: true } });
  const uploadIds = versions.map((v) => v.uploadId).filter((x): x is string => !!x);
  const [uploads, metrics, tableUploads, source, derived] = await Promise.all([
    uploadIds.length ? prisma.upload.findMany({ where: { id: { in: uploadIds } }, select: { id: true, originalFilename: true, mode: true, createdBy: true, sizeBytes: true, blobName: true } }) : Promise.resolve([]),
    prisma.jobMetric.findMany({ where: { tableId }, orderBy: { createdAt: "desc" }, take: limit }),
    prisma.upload.findMany({ where: { tableId }, select: { id: true } }),
    prisma.datasetSource.findFirst({ where: { targetTableId: tableId }, select: { id: true } }),
    prisma.derivedTable.findFirst({ where: { targetTableId: tableId }, select: { id: true } }),
  ]);
  const or: object[] = [];
  if (tableUploads.length) or.push({ uploadId: { in: tableUploads.map((u) => u.id) } });
  if (source) or.push({ payloadJson: { contains: source.id } });
  if (derived) or.push({ payloadJson: { contains: derived.id } });
  const jobs = or.length
    ? await prisma.job.findMany({ where: { OR: or, status: { in: ["COMPLETED", "FAILED"] } }, orderBy: { createdAt: "desc" }, take: limit, select: { id: true, type: true, status: true, lastError: true, createdAt: true } })
    : [];
  const filesOnDisk = new Set(uploads.filter((u) => fileExists(u.blobName)).map((u) => u.blobName));
  return buildTableHistory({ versions, uploads, metrics, jobs, filesOnDisk }, limit);
}
