/**
 * Tipos do payload do workspace de projeto (servidor → cliente). Fonte ÚNICA: antes cada componente redeclarava o
 * seu subconjunto (project-workspace, dataset-panel, table-panel). BigInt viaja como string (exato) e datas como ISO.
 */

export type WorkspaceColumn = { id: string; sqlName: string; originalName: string; sqlType: string; nullable: boolean };

export type WorkspaceSource = {
  id: string;
  name: string;
  mode: string; // "extract" | "live"
  sourceKind: string; // "table" | "query"
  sourceGroupId: string | null;
  sourceSchema: string | null;
  sourceTable: string | null;
  sourceSql: string | null;
  refreshCron: string | null;
  keyColumn: string | null;
  deltaColumn: string | null;
  reconciliationCron: string | null;
  sourceSqlReconciliation: string | null;
  detectDeletions: boolean;
  keysSql: string | null;
  keysMinIntervalMinutes: number | null;
  lastKeysCheckAt: string | null;
  lastRemovedCount: string | null;
  active: boolean;
  lastStatus: string | null;
  lastRowCount: string | null;
  lastError: string | null;
  lastRefreshedAt: string | null;
  nextRefreshAt: string | null;
  /** batimento da rodada em andamento (M2) */
  updatedAt?: string | null;
  connection: { id: string; name: string };
};

/** Último upload que alimentou a tabela (origem "arquivo"). `createdBy` só existe para uploads novos. */
export type WorkspaceUpload = { id: string; filename: string; mode: string; sizeBytes: string; createdAt: string; createdBy: string | null };

export type WorkspaceTable = {
  id: string;
  name: string;
  sqlName: string;
  rowCount: string;
  sizeBytes: string;
  lastDataAt: string | null;
  source: WorkspaceSource | null;
  columns: WorkspaceColumn[];
  lastUpload: WorkspaceUpload | null;
};

export type WorkspaceDerived = {
  id: string;
  name: string;
  sqlName: string;
  querySql: string;
  refreshCron: string | null;
  active: boolean;
  lastStatus: string | null;
  lastRowCount: string | null;
  lastError: string | null;
  lastRefreshedAt: string | null;
  nextRefreshAt: string | null;
  updatedAt?: string | null;
  targetTable: { id: string; rowCount: string; lastDataAt: string | null } | null;
};

export type WorkspaceDataset = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  active: boolean;
  schemaName: string;
  storageServerId: string | null;
  storageServer: { id: string; name: string } | null;
  tables: WorkspaceTable[];
  derivedTables: WorkspaceDerived[];
};

export type WorkspaceProject = { id: string; slug: string; name: string; description: string | null; active: boolean; datasets: WorkspaceDataset[] };

export type StorageServerOption = { id: string; name: string; isDefault: boolean };
