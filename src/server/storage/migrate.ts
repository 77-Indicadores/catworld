/**
 * Copia de datasets entre StorageServers (cross-provider: sqlserver <-> postgres).
 *
 * Usado pelos jobs MIGRATE_STORAGE_PROJECT / MIGRATE_STORAGE_DATASET (src/worker/index.ts).
 * O ponteiro (Dataset.storageServerId) so muda DEPOIS que a copia de TODAS as tabelas termina
 * sem erro — nunca durante. Assim, enquanto uma migracao roda (ou se falhar no meio), o app
 * continua lendo 100% da origem: nao existe estado "meio migrado" visivel para leitores.
 */
import { prisma } from "@/server/db";
import { getStorageConnection } from "./connection";
import type { StorageConnection, ColDef } from "./connection";
import { markNonRetryable } from "@/server/uploads/non-retryable";

export type TableCopyResult = { table: string; rows: number };
export type DatasetCopyResult = { datasetId: string; schema: string; tables: TableCopyResult[] };

type MigrateJobPayload = { projectId?: string; datasetId?: string };

/**
 * Verifica se ja existe um job de migracao (QUEUED/RUNNING) que colide com o escopo pedido —
 * seja outra migracao do mesmo dataset/projeto, seja uma migracao de projeto que inclui um dos
 * datasets, ou uma migracao de dataset cujo dataset pertence ao projeto sendo migrado. Sem essa
 * checagem, dois jobs concorrentes fariam dropTableIfExists+createTable na MESMA tabela de
 * destino ao mesmo tempo — corrompe a copia, nao so desperdica trabalho.
 * Chame dentro de withAdvisoryLock(datasetId ou projectId, ...) — a checagem sozinha ainda tem uma
 * janela de corrida entre o SELECT e o INSERT do job se dois requests chegarem ao mesmo tempo.
 */
export async function findActiveMigrationConflict(
  scope: { projectId?: string; datasetId?: string; datasetIds?: string[] },
): Promise<string | null> {
  const active = await prisma.job.findMany({
    where: { type: { in: ["MIGRATE_STORAGE_PROJECT", "MIGRATE_STORAGE_DATASET"] }, status: { in: ["QUEUED", "RUNNING"] } },
    select: { id: true, type: true, payloadJson: true },
  });
  for (const j of active) {
    let p: MigrateJobPayload;
    try { p = j.payloadJson ? (JSON.parse(j.payloadJson) as MigrateJobPayload) : {}; } catch { continue; }
    if (j.type === "MIGRATE_STORAGE_PROJECT" && p.projectId && p.projectId === scope.projectId) return j.id;
    if (j.type === "MIGRATE_STORAGE_DATASET" && p.datasetId && p.datasetId === scope.datasetId) return j.id;
    if (j.type === "MIGRATE_STORAGE_DATASET" && p.datasetId && scope.datasetIds?.includes(p.datasetId)) return j.id;
  }
  return null;
}

async function copySchema(
  src: StorageConnection,
  dst: StorageConnection,
  schema: string,
): Promise<TableCopyResult[]> {
  await dst.createSchemaIfNotExists(schema);

  const tables = await src.listTables(schema);
  const results: TableCopyResult[] = [];

  for (const table of tables) {
    const cols = await src.listColumns(schema, table);

    // Colunas internas (ex: _cw_rh) mantidas como tipo texto
    const colDefs: ColDef[] = cols.map(c => ({
      name: c.name,
      sqlType: c.sqlType,
      nullable: true,
    }));

    // Recria tabela no destino
    await dst.dropTableIfExists(schema, table);
    await dst.createTable(schema, table, colDefs);

    // Copia dados via uma unica leitura completa da tabela (sem ORDER BY/OFFSET) + bulkInsert
    // em lotes no destino. E uma copia integral: nao precisa de ordem nem de paginacao estavel,
    // e paginar com OFFSET exige ORDER BY — sem chave natural, o fallback de stableOrderBy ordena
    // por TODAS as colunas, forcando um sort completo da tabela a cada pagina (custo cresce com o
    // OFFSET, ficando cada vez mais lento: O(n^2) no total). Uma leitura unica evita isso.
    const BATCH = 2000;
    const srcQ = src.q(schema);
    const srcT = src.q(table);
    const colList = cols.map(c => src.q(c.name)).join(", ");

    const allRows = await src.query<Record<string, unknown>>(
      `SELECT ${colList} FROM ${srcQ}.${srcT}`,
    );

    for (let off = 0; off < allRows.length; off += BATCH) {
      const rows = allRows.slice(off, off + BATCH);

      const bulkRows = rows.map(row => cols.map(c => {
        const v = row[c.name];
        if (v == null) return null;
        if (v instanceof Date) {
          // Coluna TIME no MSSQL chega como Date com data 1970-01-01 — extrai só HH:MM:SS
          const t = c.sqlType?.toLowerCase() ?? "";
          if (t === "time" || t.startsWith("time(")) {
            return v.toISOString().slice(11, 19); // "HH:MM:SS"
          }
          return v.toISOString();
        }
        // String que veio do MSSQL representando time (ex: "1970-01-01T07:00:00.000Z")
        if (typeof v === "string" && /^1970-01-01T\d{2}:\d{2}:\d{2}/.test(v)) {
          const t = c.sqlType?.toLowerCase() ?? "";
          if (t === "time" || t.startsWith("time(")) {
            return v.slice(11, 19); // "HH:MM:SS"
          }
        }
        return String(v);
      }));
      await dst.bulkInsert(schema, table, colDefs, bulkRows);
    }

    results.push({ table, rows: allRows.length });
  }

  return results;
}

/**
 * Migra todos os datasets de um projeto que ainda nao estao no servidor de destino.
 * Copia tudo primeiro; so troca os ponteiros (storageServerId) de TODOS os datasets numa
 * unica transacao no final — ou o projeto migra inteiro, ou (se algo falhar) nada muda.
 * Sem essa transacao unica, um erro no meio do caminho deixava o projeto com datasets
 * divididos entre dois servidores (bug observado em producao: TMK-CONSTRUTORA com 6
 * datasets em PG4 e 5 ainda em Azure apos uma migracao interrompida).
 */
export async function migrateProjectStorage(
  projectId: string,
  targetStorageServerId: string,
): Promise<{ datasetsMigrated: number; datasets: DatasetCopyResult[] }> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      datasets: {
        where: { active: true },
        select: { id: true, schemaName: true, storageServerId: true },
      },
    },
  });
  if (!project) throw markNonRetryable(new Error("PROJECT_NOT_FOUND"));

  const datasetsToMigrate = project.datasets.filter(d => d.storageServerId !== targetStorageServerId);
  if (!datasetsToMigrate.length) throw markNonRetryable(new Error("ALREADY_ON_TARGET"));

  const dstConn = await getStorageConnection(targetStorageServerId);
  const datasetResults: DatasetCopyResult[] = [];

  for (const dataset of datasetsToMigrate) {
    const srcConn = await getStorageConnection(dataset.storageServerId!);
    const tables = await copySchema(srcConn, dstConn, dataset.schemaName);
    datasetResults.push({ datasetId: dataset.id, schema: dataset.schemaName, tables });
  }

  // Commit atomico: so chega aqui se TODOS os datasets copiaram com sucesso.
  await prisma.$transaction(
    datasetsToMigrate.map(d =>
      prisma.dataset.update({ where: { id: d.id }, data: { storageServerId: targetStorageServerId } }),
    ),
  );

  return { datasetsMigrated: datasetResults.length, datasets: datasetResults };
}

/** Migra um unico dataset (cross-provider). Ja e atomico por natureza: 1 dataset = 1 ponteiro. */
export async function migrateDatasetStorage(
  datasetId: string,
  targetStorageServerId: string,
): Promise<DatasetCopyResult> {
  const dataset = await prisma.dataset.findUnique({
    where: { id: datasetId },
    select: { id: true, schemaName: true, storageServerId: true, active: true },
  });
  if (!dataset || !dataset.active) throw markNonRetryable(new Error("DATASET_NOT_FOUND"));
  if (dataset.storageServerId === targetStorageServerId) throw markNonRetryable(new Error("ALREADY_ON_TARGET"));

  const dstConn = await getStorageConnection(targetStorageServerId);
  const srcConn = await getStorageConnection(dataset.storageServerId!);
  const tables = await copySchema(srcConn, dstConn, dataset.schemaName);

  await prisma.dataset.update({ where: { id: dataset.id }, data: { storageServerId: targetStorageServerId } });

  return { datasetId: dataset.id, schema: dataset.schemaName, tables };
}
