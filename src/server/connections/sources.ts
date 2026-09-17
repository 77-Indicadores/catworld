import { randomUUID } from "crypto";
import { Cron } from "croner";
import { prisma } from "@/server/db";
import { withAdvisoryLock } from "@/server/db/advisory-lock";
import { sqlPool, ensureSchema } from "@/server/azure/sql";
import { getStorageConnection, type StorageConnection } from "@/server/storage/connection";
import { sqlIdentifier } from "@/server/security/naming";
import { ApiError } from "@/server/http";
import { queryColumns, quotedPgTable, streamPostgresRows, tableColumns, type SourceColumn } from "./postgres";
import { queryColumnsMssql, quotedMssqlTable, streamMssqlRows, tableColumnsMssql } from "./mssql";

export function nextRefreshFromCron(cronExpr: string | null | undefined, from = new Date()): Date | null {
  if (!cronExpr) return null;
  try {
    return new Cron(cronExpr, { timezone: "UTC" }).nextRun(from) ?? null;
  } catch {
    return null;
  }
}

export async function queueSourceRefresh(datasetSourceId: string, opts?: { reconciliation?: boolean }) {
  const reconciliation = !!opts?.reconciliation;
  // Use Postgres advisory lock to prevent race condition where two workers both see "no existing job"
  // and both insert, creating duplicate SOURCE_REFRESH jobs for the same source.
  return withAdvisoryLock(datasetSourceId, async () => {
    const candidates = await prisma.job.findMany({
      where: { type: "SOURCE_REFRESH", status: { in: ["QUEUED", "RUNNING"] } },
      select: { id: true, status: true, payloadJson: true },
    });
    // Compara campos parseados, não a string exata — um job de reconciliação em fila
    // nao deve ser confundido com (nem deduplicado contra) um refresh normal do mesmo
    // source, e vice-versa.
    const existing = candidates.find(j => {
      try {
        const p = JSON.parse(j.payloadJson ?? "{}") as { datasetSourceId?: string; reconciliation?: boolean };
        return p.datasetSourceId === datasetSourceId && !!p.reconciliation === reconciliation;
      } catch { return false; }
    });
    if (existing) {
      if (existing.status === "QUEUED") {
        await prisma.datasetSource.update({ where: { id: datasetSourceId }, data: { lastStatus: "queued", lastError: null } });
      }
      return existing;
    }
    const [job] = await prisma.$transaction([
      prisma.job.create({ data: { type: "SOURCE_REFRESH", payloadJson: JSON.stringify({ datasetSourceId, reconciliation }), maxAttempts: 3, weight: 2 } }),
      prisma.datasetSource.update({ where: { id: datasetSourceId }, data: { lastStatus: "queued", lastError: null } }),
    ]);
    return job;
  });
}

export async function enqueueDueSourceRefreshes() {
  const { getWorkerConfig } = await import("@/server/worker/config");
  const { maxSyncsPerStorage } = await getWorkerConfig();

  // Conta SOURCE_REFRESH RUNNING por storageServerId (via dataset)
  const runningJobs = await prisma.job.findMany({
    where: { type: "SOURCE_REFRESH", status: "RUNNING" },
    select: { payloadJson: true },
  });

  // Mapeia sourceId → storageServerId para os jobs em execução
  const runningSources = runningJobs.map(j => {
    try { return (JSON.parse(j.payloadJson ?? "") as { datasetSourceId?: string }).datasetSourceId ?? null; } catch { return null; }
  }).filter((id): id is string => id != null);

  const runningSyncsPerStorage = new Map<string, number>();
  if (runningSources.length) {
    const sourceDatasets = await prisma.datasetSource.findMany({
      where: { id: { in: runningSources } },
      select: { dataset: { select: { storageServerId: true } } },
    });
    for (const s of sourceDatasets) {
      const sid = s.dataset.storageServerId ?? "__default__";
      runningSyncsPerStorage.set(sid, (runningSyncsPerStorage.get(sid) ?? 0) + 1);
    }
  }

  const due = await prisma.datasetSource.findMany({
    where: {
      active: true,
      mode: "extract",
      refreshCron: { not: null },
      nextRefreshAt: { lte: new Date() },
    },
    select: { id: true, dataset: { select: { storageServerId: true } } },
    orderBy: { nextRefreshAt: "asc" },
    take: 50,
  });

  for (const source of due) {
    const sid = source.dataset.storageServerId ?? "__default__";
    const running = runningSyncsPerStorage.get(sid) ?? 0;
    if (running >= maxSyncsPerStorage) continue;
    runningSyncsPerStorage.set(sid, running + 1);
    await queueSourceRefresh(source.id);
  }
}

/** Espelha enqueueDueSourceRefreshes, mas para o cron secundário de reconciliação
 * (full snapshot periódico — ver refreshDatasetSource com opts.reconciliation). */
export async function enqueueDueReconciliations() {
  const { getWorkerConfig } = await import("@/server/worker/config");
  const { maxSyncsPerStorage } = await getWorkerConfig();

  const runningJobs = await prisma.job.findMany({
    where: { type: "SOURCE_REFRESH", status: "RUNNING" },
    select: { payloadJson: true },
  });
  const runningSources = runningJobs.map(j => {
    try { return (JSON.parse(j.payloadJson ?? "") as { datasetSourceId?: string }).datasetSourceId ?? null; } catch { return null; }
  }).filter((id): id is string => id != null);

  const runningSyncsPerStorage = new Map<string, number>();
  if (runningSources.length) {
    const sourceDatasets = await prisma.datasetSource.findMany({
      where: { id: { in: runningSources } },
      select: { dataset: { select: { storageServerId: true } } },
    });
    for (const s of sourceDatasets) {
      const sid = s.dataset.storageServerId ?? "__default__";
      runningSyncsPerStorage.set(sid, (runningSyncsPerStorage.get(sid) ?? 0) + 1);
    }
  }

  const due = await prisma.datasetSource.findMany({
    where: {
      active: true,
      mode: "extract",
      reconciliationCron: { not: null },
      nextReconciliationAt: { lte: new Date() },
    },
    select: { id: true, dataset: { select: { storageServerId: true } } },
    orderBy: { nextReconciliationAt: "asc" },
    take: 50,
  });

  for (const source of due) {
    const sid = source.dataset.storageServerId ?? "__default__";
    const running = runningSyncsPerStorage.get(sid) ?? 0;
    if (running >= maxSyncsPerStorage) continue;
    runningSyncsPerStorage.set(sid, running + 1);
    await queueSourceRefresh(source.id, { reconciliation: true });
  }
}

export async function createDatasetSource(input: {
  datasetId: string;
  connectionId: string;
  name?: string;
  mode: "extract" | "live";
  sourceKind: "table" | "query";
  sourceSchema?: string | null;
  sourceTable?: string | null;
  sourceSql?: string | null;
  refreshCron?: string | null;
  keyColumn?: string | null;
  deltaColumn?: string | null;
  reconciliationCron?: string | null;
  sourceSqlReconciliation?: string | null;
  sourceGroupId?: string;
}) {
  const [dataset, connection] = await Promise.all([
    prisma.dataset.findUnique({ where: { id: input.datasetId }, include: { project: true } }),
    prisma.connection.findUnique({ where: { id: input.connectionId } }),
  ]);
  if (!dataset) throw new ApiError(404, "DATASET_NOT_FOUND", "Dataset nao encontrado");
  if (!connection || !connection.active) throw new ApiError(404, "CONNECTION_NOT_FOUND", "Conexao nao encontrada");
  if (!["postgres", "mssql"].includes(connection.provider)) throw new ApiError(400, "UNSUPPORTED_PROVIDER", `Provider ${connection.provider} nao suportado`);
  if (input.sourceKind === "table" && (!input.sourceSchema || !input.sourceTable)) throw new ApiError(400, "INVALID_SOURCE", "Tabela exige schema e nome");
  if (input.sourceKind === "query" && !input.sourceSql?.trim()) throw new ApiError(400, "INVALID_SOURCE", "Consulta obrigatoria");
  // Sem a consulta de reconciliacao, fullSnapshot rodaria sobre a query janelada
  // normal e marcaria quase tudo como excluido por engano.
  if (input.reconciliationCron?.trim() && input.sourceKind === "query" && !input.sourceSqlReconciliation?.trim()) {
    throw new ApiError(400, "RECONCILIATION_SQL_REQUIRED", "Fontes por consulta exigem uma consulta de reconciliacao (sem filtro de data) para habilitar o cron de reconciliacao");
  }

  const columns = input.sourceKind === "table"
    ? (connection.provider === "mssql" ? await tableColumnsMssql(connection, input.sourceSchema!, input.sourceTable!) : await tableColumns(connection, input.sourceSchema!, input.sourceTable!))
    : (connection.provider === "mssql" ? await queryColumnsMssql(connection, input.sourceSql!) : await queryColumns(connection, input.sourceSql!));
  if (!columns.length) throw new ApiError(400, "EMPTY_SOURCE", "Fonte nao retornou colunas");

  const displayName = input.sourceKind === "table" ? input.sourceTable! : input.name!;
  const tableName = sqlIdentifier(displayName);
  const table = await prisma.datasetTable.upsert({
    where: { datasetId_sqlName: { datasetId: dataset.id, sqlName: tableName } },
    update: { name: displayName },
    create: { datasetId: dataset.id, name: displayName, sqlName: tableName },
  });
  await replaceColumnCatalog(table.id, columns, 0n);

  const source = await prisma.datasetSource.create({
    data: {
      datasetId: dataset.id,
      connectionId: connection.id,
      targetTableId: table.id,
      name: displayName,
      mode: input.mode,
      sourceKind: input.sourceKind,
      sourceGroupId: input.sourceGroupId ?? null,
      sourceSchema: input.sourceSchema ?? null,
      sourceTable: input.sourceTable ?? null,
      sourceSql: input.sourceSql ?? null,
      keyColumn: input.keyColumn ?? null,
      deltaColumn: input.sourceKind === "table" ? (input.deltaColumn ?? null) : null,
      refreshCron: input.mode === "live" ? null : (input.refreshCron ?? null),
      reconciliationCron: input.mode === "live" ? null : (input.reconciliationCron ?? null),
      sourceSqlReconciliation: input.sourceKind === "query" ? (input.sourceSqlReconciliation ?? null) : null,
      nextReconciliationAt: input.mode === "extract" ? nextRefreshFromCron(input.reconciliationCron) : null,
      lastStatus: input.mode === "live" ? "ready" : "queued",
      nextRefreshAt: input.mode === "extract" ? nextRefreshFromCron(input.refreshCron) : null,
    },
    include: { connection: true, targetTable: { include: { columns: { orderBy: { ordinal: "asc" } } } } },
  });
  if (input.mode === "extract") await queueSourceRefresh(source.id);
  return source;
}

export async function createDatasetSources(input: {
  datasetId: string;
  connectionId: string;
  mode: "extract" | "live";
  sourceSchema: string;
  sourceTables: string[];
  refreshCron?: string | null;
  keyColumn?: string | null;
  deltaColumn?: string | null;
  sourceGroupId?: string;
}) {
  const sourceGroupId = input.sourceGroupId ?? randomUUID();
  const sources = [];
  for (const table of input.sourceTables) {
    sources.push(await createDatasetSource({
      datasetId: input.datasetId,
      connectionId: input.connectionId,
      mode: input.mode,
      sourceKind: "table",
      sourceSchema: input.sourceSchema,
      sourceTable: table,
      refreshCron: input.refreshCron,
      keyColumn: input.keyColumn,
      deltaColumn: input.deltaColumn,
      sourceGroupId,
    }));
  }
  return sources;
}

export async function refreshDatasetSource(datasetSourceId: string, opts?: { reconciliation?: boolean }) {
  const reconciliation = !!opts?.reconciliation;
  const source = await prisma.datasetSource.findUnique({
    where: { id: datasetSourceId },
    include: { dataset: true, connection: true, targetTable: true },
  });
  if (!source || !source.active) throw new ApiError(404, "SOURCE_NOT_FOUND", "Fonte não encontrada");
  if (source.mode !== "extract") throw new ApiError(400, "INVALID_SOURCE_MODE", "Apenas fontes extract podem ser atualizadas");
  if (!source.targetTable) throw new ApiError(400, "SOURCE_NO_TARGET_TABLE", "Fonte sem tabela de destino");
  if (reconciliation && source.sourceKind === "query" && !source.sourceSqlReconciliation?.trim()) {
    throw new ApiError(400, "RECONCILIATION_SQL_REQUIRED", "Fonte sem consulta de reconciliacao configurada");
  }

  const isMssql = source.connection.provider === "mssql";

  // Delta: only fetch rows newer than lastDeltaValue (table sources only, requires keyColumn for upsert).
  // Numa rodada de reconciliacao, o delta e ignorado de proposito: le a tabela inteira
  // (sem WHERE) para poder detectar exclusoes que a busca parcial nunca veria.
  const useDelta = !reconciliation && !!(source.deltaColumn && source.lastDeltaValue && source.keyColumn && source.sourceKind === "table");
  // Reconciliacao em fonte por consulta usa o SQL sem filtro de data (sourceSqlReconciliation),
  // nunca o sourceSql janelado normal — ja validado acima que existe quando reconciliation=true.
  const effectiveSourceSql = reconciliation && source.sourceKind === "query" ? source.sourceSqlReconciliation! : source.sourceSql!;
  const baseTableQuery = source.sourceKind === "table"
    ? `SELECT * FROM ${isMssql ? quotedMssqlTable(source.sourceSchema!, source.sourceTable!) : quotedPgTable(source.sourceSchema!, source.sourceTable!)}`
    : effectiveSourceSql;
  const quoteCol = (col: string) => isMssql ? `[${col.replace(/]/g, "]]")}]` : `"${col.replace(/"/g, '""')}"`;
  const query = useDelta
    ? `${baseTableQuery} WHERE ${quoteCol(source.deltaColumn!)} > '${source.lastDeltaValue!.replace(/'/g, "''")}'`
    : baseTableQuery;

  const columns = source.sourceKind === "table"
    ? (isMssql ? await tableColumnsMssql(source.connection, source.sourceSchema!, source.sourceTable!) : await tableColumns(source.connection, source.sourceSchema!, source.sourceTable!))
    : (isMssql ? await queryColumnsMssql(source.connection, effectiveSourceSql) : await queryColumns(source.connection, effectiveSourceSql));

  const storageConn = await getStorageConnection(source.dataset.storageServerId);
  const schema = source.dataset.schemaName;
  const table = source.targetTable.sqlName;
  const idPrefix = source.id.replaceAll("-", "").slice(0, 20);
  // Sufixo distinto pro staging/merge de reconciliação — incremental e reconciliação
  // da MESMA fonte nunca devem tocar a mesma tabela intermediária, mesmo que a trava
  // abaixo falhe por algum motivo (defesa em profundidade).
  const stage = reconciliation ? `cw_src_${idPrefix}_rc` : `cw_src_${idPrefix}`;
  let rowCount = 0n;

  // Trava mútua: incremental e reconciliação da mesma fonte nunca podem rodar ao
  // mesmo tempo (colidiriam na mesma tabela final via atomicSwap). UPDATE condicional
  // atômico — se outra rodada já está "running", 0 linhas são afetadas e abortamos
  // aqui, deixando o job falhar e reagendar pelo retry normal (backoff do worker),
  // sem segurar transação/lock aberto pela duração inteira do refresh (que pode levar
  // minutos com uma origem grande).
  const claimed = await prisma.datasetSource.updateMany({
    where: { id: source.id, lastStatus: { not: "running" } },
    data: { lastStatus: "running", lastError: null },
  });
  if (claimed.count === 0) {
    throw new ApiError(409, "SOURCE_REFRESH_IN_PROGRESS", "Já existe uma atualização em andamento para esta fonte (incremental ou reconciliação) — tente novamente em instantes");
  }
  await storageConn.createSchemaIfNotExists(schema);

  // Cria tabela staging com os tipos canônicos das colunas
  const stageCols = columns.map(c => ({ name: c.sqlName, sqlType: c.sqlType, nullable: true }));
  await storageConn.dropTableIfExists(schema, stage);
  await storageConn.createTable(schema, stage, stageCols);

  try {
    const STREAM_BATCH = 1000;
    for await (const rows of (isMssql ? streamMssqlRows(source.connection, query, STREAM_BATCH) : streamPostgresRows(source.connection, query, STREAM_BATCH))) {
      const bulkRows = rows.map(row => columns.map(c => convertSourceValue(row[c.originalName], c.sqlType)));
      await storageConn.bulkInsert(schema, stage, stageCols, bulkRows);
      rowCount += BigInt(rows.length);
    }

    // Captura novo delta ANTES de trocar/dropar staging
    let newDeltaValue: string | null | undefined = undefined;
    if (source.deltaColumn && source.sourceKind === "table" && source.keyColumn) {
      const col = storageConn.q(source.deltaColumn);
      const qStage = `${storageConn.q(schema)}.${storageConn.q(stage)}`;
      const res = await storageConn.query<{ v: unknown }>(`SELECT MAX(${col}) AS v FROM ${qStage}`);
      const v = res[0]?.v;
      if (v != null) newDeltaValue = v instanceof Date ? v.toISOString() : String(v);
    }

    // Swap atômico (upsert ou replace). Upsert por keyColumn funciona para qualquer
    // sourceKind (table ou query) — independe de haver deltaColumn/fetch incremental,
    // que é exclusivo de sourceKind "table". Para "query", o corte incremental (janela,
    // filtro de data etc.) fica embutido no próprio SQL cadastrado pelo usuário.
    const hasTarget = await storageConn.tableExists(schema, table);
    const useKeyMerge = !!source.keyColumn && hasTarget;
    if (useKeyMerge) await assertKeyColumnSafe(storageConn, schema, stage, source.keyColumn!);
    // fullSnapshot: só é seguro tratar "ausente da staging" como excluído na origem
    // quando a staging representa 100% do estado atual — ou seja, em reconciliação
    // (sempre) ou em sourceKind "table" sem deltaColumn (fetch sempre completo, nunca
    // parcial). Fontes por consulta fora da reconciliação são, por padrão, tratadas
    // como parciais (o filtro de janela fica embutido no SQL do usuário e o Catworld
    // não tem como saber se ele cobre 100% da origem) — nunca marcam exclusão por conta
    // própria, só quando reconciliation=true.
    const fullSnapshot = reconciliation || (source.sourceKind === "table" && !useDelta);
    await storageConn.atomicSwap(schema, stage, table, stageCols, {
      targetExists: hasTarget,
      keyColumn: useKeyMerge ? source.keyColumn : null,
      mergedName: useKeyMerge ? (reconciliation ? `cw_mgd_${idPrefix}_rc` : `cw_mgd_${idPrefix}`) : undefined,
      fullSnapshot,
    });

    const finalRowCount = await storageConn.countRows(schema, table);

    await replaceColumnCatalog(source.targetTable.id, columns, finalRowCount);
    await prisma.datasetSource.update({
      where: { id: source.id },
      data: {
        lastStatus: "completed",
        lastRowCount: finalRowCount,
        lastError: null,
        lastRefreshedAt: new Date(),
        ...(reconciliation
          ? { nextReconciliationAt: nextRefreshFromCron(source.reconciliationCron), lastReconciliationAt: new Date() }
          : { nextRefreshAt: nextRefreshFromCron(source.refreshCron) }),
        ...(newDeltaValue !== undefined ? { lastDeltaValue: newDeltaValue } : {}),
      },
    });
    return { rowCount: finalRowCount };
  } catch (e) {
    await storageConn.dropTableIfExists(schema, stage).catch(() => undefined);
    const message = e instanceof Error ? e.message : String(e);
    await prisma.datasetSource.update({
      where: { id: source.id },
      data: {
        lastStatus: "failed",
        lastError: message,
        ...(reconciliation
          ? { nextReconciliationAt: nextRefreshFromCron(source.reconciliationCron) }
          : { nextRefreshAt: nextRefreshFromCron(source.refreshCron) }),
      },
    });
    throw e;
  }
}

/** Garante que a keyColumn na staging não tem nulos nem duplicatas antes do merge por upsert */
async function assertKeyColumnSafe(
  storageConn: StorageConnection,
  schema: string,
  stage: string,
  keyColumn: string,
) {
  const qStage = `${storageConn.q(schema)}.${storageConn.q(stage)}`;
  const key = storageConn.q(keyColumn);

  const nulls = await storageConn.query<{ n: number | bigint }>(`SELECT COUNT(*) AS n FROM ${qStage} WHERE ${key} IS NULL`);
  const nullCount = Number(nulls[0]?.n ?? 0);
  if (nullCount > 0) {
    throw new ApiError(400, "UPSERT_NULL_KEY", `Coluna-chave "${keyColumn}" tem ${nullCount} valor(es) nulo(s) — upsert exige chave sempre preenchida`);
  }

  const duplicates = await storageConn.query<{ k: unknown; n: number | bigint }>(
    `SELECT ${key} AS k, COUNT(*) AS n FROM ${qStage} GROUP BY ${key} HAVING COUNT(*) > 1`,
  );
  if (duplicates.length) {
    const sample = duplicates.slice(0, 20).map(r => `${r.k} (x${Number(r.n)})`).join(", ");
    const more = duplicates.length > 20 ? " (mostrando as primeiras 20)" : "";
    throw new ApiError(400, "UPSERT_DUPLICATE_KEY", `Coluna-chave "${keyColumn}" tem valores duplicados na origem: ${sample}${more}`);
  }
}

/** Converte valor de fonte para string compatível com bulkInsert */
function convertSourceValue(value: unknown, type: string): string | null {
  if (value == null) return null;
  if (type === "BIGINT") {
    const s = typeof value === "bigint" ? value.toString() : String(value).trim();
    if (!/^-?\d+$/.test(s)) return null;
    return s;
  }
  if (type.startsWith("DECIMAL")) {
    const n = Number(value);
    if (!Number.isFinite(n) || Math.abs(n) >= 1e14) return null;
    return String(n);
  }
  if (type === "DATE" || type === "DATETIME2") {
    const d = value instanceof Date ? value : new Date(String(value));
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  }
  if (type === "TIME") return String(value);
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}


async function replaceColumnCatalog(tableId: string, columns: SourceColumn[], rowCount: bigint) {
  await prisma.$transaction([
    prisma.datasetColumn.deleteMany({ where: { tableId } }),
    prisma.datasetTable.update({ where: { id: tableId }, data: { rowCount, lastDataAt: new Date() } }),
    prisma.datasetColumn.createMany({
      data: columns.map((column, index) => ({
        tableId,
        ordinal: index + 1,
        originalName: column.originalName,
        sqlName: column.sqlName,
        sqlType: column.sqlType,
        nullable: column.nullable,
      })),
    }),
    prisma.datasetVersion.create({ data: { tableId, rowCount, schemaJson: JSON.stringify(columns) } }),
  ]);
}
