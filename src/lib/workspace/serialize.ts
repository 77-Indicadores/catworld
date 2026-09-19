/**
 * Serializador ÚNICO do workspace: converte o resultado do Prisma no payload enviado ao cliente (BigInt → string
 * exata, Date → ISO). Só campos escalares — nada volumoso. Lado servidor (importa o Prisma só como tipo e para as
 * consultas auxiliares).
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import type { WorkspaceDataset, WorkspaceProject, WorkspaceTable, WorkspaceUpload } from "./types";

export const WORKSPACE_INCLUDE = {
  datasets: {
    where: { active: true },
    include: {
      storageServer: { select: { id: true, name: true } },
      tables: { include: { columns: { orderBy: { ordinal: "asc" } }, source: { include: { connection: true } } } },
      derivedTables: {
        where: { active: true },
        orderBy: { createdAt: "asc" },
        include: { targetTable: { select: { id: true, rowCount: true, lastDataAt: true } } },
      },
    },
  },
} satisfies Prisma.ProjectInclude;

export type WorkspaceProjectRow = Prisma.ProjectGetPayload<{ include: typeof WORKSPACE_INCLUDE }>;

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;
const big = (v: bigint | number | null | undefined) => (v === null || v === undefined ? null : String(v));

/** Último upload que alimentou cada tabela (pela versão mais recente com `uploadId`). */
export async function loadLastUploads(tableIds: string[]): Promise<Map<string, WorkspaceUpload>> {
  const out = new Map<string, WorkspaceUpload>();
  if (tableIds.length === 0) return out;
  const versions = await prisma.datasetVersion.findMany({
    where: { tableId: { in: tableIds }, uploadId: { not: null } },
    orderBy: { createdAt: "desc" },
    distinct: ["tableId"],
    select: { tableId: true, uploadId: true },
  });
  const ids = versions.map((v) => v.uploadId!).filter(Boolean);
  if (ids.length === 0) return out;
  const uploads = await prisma.upload.findMany({ where: { id: { in: ids } }, select: { id: true, originalFilename: true, mode: true, sizeBytes: true, createdAt: true, createdBy: true } });
  const byId = new Map(uploads.map((u) => [u.id, u]));
  for (const v of versions) {
    const u = byId.get(v.uploadId!);
    if (u) out.set(v.tableId, { id: u.id, filename: u.originalFilename, mode: u.mode, sizeBytes: String(u.sizeBytes), createdAt: u.createdAt.toISOString(), createdBy: u.createdBy });
  }
  return out;
}

export function serializeWorkspaceProject(p: WorkspaceProjectRow, lastUploads: Map<string, WorkspaceUpload> = new Map()): WorkspaceProject {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    description: p.description,
    active: p.active,
    datasets: p.datasets.map((d): WorkspaceDataset => ({
      id: d.id,
      slug: d.slug,
      name: d.name,
      description: d.description,
      active: d.active,
      schemaName: d.schemaName,
      storageServerId: d.storageServerId,
      storageServer: d.storageServer ? { id: d.storageServer.id, name: d.storageServer.name } : null,
      tables: d.tables.map((t): WorkspaceTable => ({
        id: t.id,
        name: t.name,
        sqlName: t.sqlName,
        rowCount: String(t.rowCount),
        sizeBytes: String(t.sizeBytes ?? 0),
        lastDataAt: iso(t.lastDataAt),
        lastUpload: lastUploads.get(t.id) ?? null,
        source: t.source
          ? {
              id: t.source.id,
              name: t.source.name,
              mode: t.source.mode,
              sourceKind: t.source.sourceKind,
              sourceGroupId: t.source.sourceGroupId,
              sourceSchema: t.source.sourceSchema,
              sourceTable: t.source.sourceTable,
              sourceSql: t.source.sourceSql,
              refreshCron: t.source.refreshCron,
              keyColumn: t.source.keyColumn,
              deltaColumn: t.source.deltaColumn,
              reconciliationCron: t.source.reconciliationCron,
              sourceSqlReconciliation: t.source.sourceSqlReconciliation,
              lastStatus: t.source.lastStatus,
              lastRowCount: big(t.source.lastRowCount),
              lastError: t.source.lastError,
              active: t.source.active,
              lastRefreshedAt: iso(t.source.lastRefreshedAt),
              nextRefreshAt: iso(t.source.nextRefreshAt),
              connection: { id: t.source.connection.id, name: t.source.connection.name },
            }
          : null,
        columns: t.columns.map((c) => ({ id: c.id, sqlName: c.sqlName, originalName: c.originalName, sqlType: c.sqlType, nullable: c.nullable })),
      })),
      derivedTables: d.derivedTables.map((dt) => ({
        id: dt.id,
        name: dt.name,
        sqlName: dt.sqlName,
        querySql: dt.querySql,
        refreshCron: dt.refreshCron,
        active: dt.active,
        lastStatus: dt.lastStatus,
        lastRowCount: big(dt.lastRowCount),
        lastError: dt.lastError,
        lastRefreshedAt: iso(dt.lastRefreshedAt),
        nextRefreshAt: iso(dt.nextRefreshAt),
        targetTable: dt.targetTable ? { id: dt.targetTable.id, rowCount: String(dt.targetTable.rowCount), lastDataAt: iso(dt.targetTable.lastDataAt) } : null,
      })),
    })),
  };
}
