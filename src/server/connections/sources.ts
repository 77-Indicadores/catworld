import { randomUUID } from "crypto";
import { Cron } from "croner";
import { prisma } from "@/server/db";
import { withAdvisoryLock } from "@/server/db/advisory-lock";
import { sqlPool, ensureSchema } from "@/server/azure/sql";
import { getStorageConnection, type StorageConnection } from "@/server/storage/connection";
import { sqlIdentifier } from "@/server/security/naming";
import { ApiError } from "@/server/http";
import { normalizeScopeColumns, parseScopeColumns } from "./scope-columns";
import { KEYS_CHECK_MAX_RATIO } from "@/server/storage/delete-detection";
import { getTombstoneTtlDays } from "@/server/storage/tombstone-ttl";
import { queryColumns, quotedPgTable, streamPostgresRows, tableColumns, type SourceColumn } from "./postgres";
import { queryColumnsMssql, quotedMssqlTable, streamMssqlRows, tableColumnsMssql } from "./mssql";

/** Cron invalido virava "sem agendamento" em silêncio (a fonte nunca atualizava); agora e 400. Vazio/null = sem agendamento. */
export function assertValidCron(expr: string | null | undefined, field = "refreshCron"): void {
  if (!expr?.trim()) return;
  try {
    new Cron(expr, { timezone: "UTC" });
  } catch {
    throw new ApiError(400, "INVALID_CRON", `Expressao cron invalida em ${field}: "${expr}"`);
  }
}

export function nextRefreshFromCron(cronExpr: string | null | undefined, from = new Date()): Date | null {
  if (!cronExpr) return null;
  try {
    return new Cron(cronExpr, { timezone: "UTC" }).nextRun(from) ?? null;
  } catch {
    return null;
  }
}

export { parseScopeColumns, normalizeScopeColumns };

/** Tabelas ja sem linhas no formato legado (soft delete) neste processo. */
const LEGACY_CLEAN = new Set<string>();
/** So para testes: esquece quais tabelas ja foram checadas. */
export function resetLegacyCleanCache() { LEGACY_CLEAN.clear(); }

/** Fonte como a API devolve: `scopeColumns` vira array (no banco e JSON em texto). */
export function exposeSource<T extends { scopeColumns?: string | null }>(source: T): Omit<T, "scopeColumns"> & { scopeColumns: string[] | null } {
  return { ...source, scopeColumns: parseScopeColumns(source.scopeColumns) };
}

/**
 * Valida a deteccao de exclusoes (escopo e verificacao de chaves) contra o estado RESULTANTE da fonte.
 * Fonte live ignora tudo (os campos sao zerados). `knownColumns` (nomes SQL) valida o escopo quando conhecido.
 */
export function assertDeleteDetection(i: {
  mode: string; sourceKind: string; keyColumn?: string | null; scopeColumns?: string[] | null;
  keysCheckCron?: string | null; keysSql?: string | null;
}, knownColumns?: string[]): void {
  assertValidCron(i.keysCheckCron, "keysCheckCron");
  if (i.mode === "live") return;
  const scope = normalizeScopeColumns(i.scopeColumns);
  const hasKey = !!i.keyColumn?.trim();
  if (scope && !hasKey) throw new ApiError(400, "SCOPE_REQUIRES_KEY", "Colunas de escopo exigem coluna-chave");
  if (scope && knownColumns?.length) {
    const unknown = scope.filter(c => !knownColumns.includes(c));
    if (unknown.length) throw new ApiError(400, "SCOPE_COLUMN_UNKNOWN", `Coluna(s) de escopo inexistente(s) na fonte: ${unknown.join(", ")}`);
  }
  if (i.keysCheckCron?.trim() && !hasKey) throw new ApiError(400, "KEYS_CHECK_REQUIRES_KEY", "Verificacao de chaves exige coluna-chave");
  if (i.keysSql?.trim() && i.sourceKind !== "query") throw new ApiError(400, "KEYS_SQL_NOT_ALLOWED", "Consulta de chaves so existe em fontes por consulta (em tabela as chaves sao lidas direto da tabela)");
  if (i.keysCheckCron?.trim() && i.sourceKind === "query" && !i.keysSql?.trim()) {
    throw new ApiError(400, "KEYS_SQL_REQUIRED", "Fontes por consulta exigem a consulta de chaves (uma coluna, mesmo formato da coluna-chave) para habilitar a verificacao de chaves");
  }
}

/**
 * Princípio único de peso de job (ver também actions.ts para uploads, derived.ts
 * para tabelas derivadas): bounded = volume de dados conhecido/limitado por
 * construção (nunca gateado por max_heavy_jobs); unbounded = pode ser qualquer
 * tamanho, inclusive a tabela inteira (gateado, weight 2).
 *
 * Uma rodada de fonte é bounded quando é janelada por construção — tabela com
 * deltaColumn já tendo capturado um baseline (lastDeltaValue), ou consulta fora de
 * reconciliação (a janela fica embutida no SQL do usuário, por convenção). É
 * unbounded em reconciliação (sempre, por definição) ou tabela sem delta
 * configurado (lê tudo, toda vez, inclusive a primeira carga de qualquer fonte).
 */
function isBoundedSourceRun(
  source: { sourceKind: string; deltaColumn: string | null; lastDeltaValue: string | null; keyColumn: string | null },
  reconciliation: boolean,
): boolean {
  if (reconciliation) return false;
  if (source.sourceKind === "table") return !!(source.deltaColumn && source.lastDeltaValue && source.keyColumn);
  return true;
}

/** `not: "running"` em SQL nao casa NULL; inclui lastStatus nulo explicitamente. */
const NOT_RUNNING = { OR: [{ lastStatus: null }, { lastStatus: { not: "running" } }] };

export async function queueSourceRefresh(datasetSourceId: string, opts?: { reconciliation?: boolean }) {
  const reconciliation = !!opts?.reconciliation;
  // Use Postgres advisory lock to prevent race condition where two workers both see "no existing job"
  // and both insert, creating duplicate SOURCE_REFRESH jobs for the same source.
  return withAdvisoryLock(datasetSourceId, async () => {
    const [candidates, source] = await Promise.all([
      prisma.job.findMany({
        where: { type: "SOURCE_REFRESH", status: { in: ["QUEUED", "RUNNING"] } },
        select: { id: true, status: true, payloadJson: true },
      }),
      prisma.datasetSource.findUniqueOrThrow({
        where: { id: datasetSourceId },
        select: { sourceKind: true, deltaColumn: true, lastDeltaValue: true, keyColumn: true, dataset: { select: { storageServerId: true } } },
      }),
    ]);
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
        await prisma.datasetSource.updateMany({ where: { id: datasetSourceId, ...NOT_RUNNING }, data: { lastStatus: "queued", lastError: null } });
      }
      return existing;
    }
    const weight = isBoundedSourceRun(source, reconciliation) ? 0 : 2;
    // Bucket "__default__" pro storage padrão (storageServerId null no dataset) —
    // nunca grava NULL aqui: NULL no Job.storageServerId é reservado pra "job não é
    // do tipo SOURCE_REFRESH" (ver claim() em worker/index.ts), não "storage padrão".
    const storageBucket = source.dataset.storageServerId ?? "__default__";
    const [job] = await prisma.$transaction([
      prisma.job.create({ data: { type: "SOURCE_REFRESH", payloadJson: JSON.stringify({ datasetSourceId, reconciliation }), maxAttempts: 3, weight, storageServerId: storageBucket } }),
      // Nao sobrescreve uma fonte "running" (derrubaria a trava mutua do refresh).
      prisma.datasetSource.updateMany({ where: { id: datasetSourceId, ...NOT_RUNNING }, data: { lastStatus: "queued", lastError: null } }),
    ]);
    return job;
  });
}

/**
 * Enfileira toda fonte com refreshCron vencido. O teto de quantos syncs rodam ao
 * mesmo tempo por storage (maxSyncsPerStorage) NÃO é checado aqui — o job sempre
 * entra na fila; quem decide se/quando ele começa a rodar é o claim() do worker
 * (mesmo padrão de weight/maxHeavyJobs). Checar isso aqui, na hora de enfileirar,
 * fazia uma fonte "perder a vaga" repetidamente sem nunca chegar a existir como job.
 */
export async function enqueueDueSourceRefreshes() {
  const due = await prisma.datasetSource.findMany({
    where: {
      active: true,
      mode: "extract",
      refreshCron: { not: null },
      nextRefreshAt: { lte: new Date() },
    },
    select: { id: true },
    orderBy: { nextRefreshAt: "asc" },
    take: 50,
  });
  for (const source of due) await queueSourceRefresh(source.id);
}

/** Espelha enqueueDueSourceRefreshes, mas para o cron secundário de reconciliação
 * (full snapshot periódico — ver refreshDatasetSource com opts.reconciliation). */
export async function enqueueDueReconciliations() {
  const due = await prisma.datasetSource.findMany({
    where: {
      active: true,
      mode: "extract",
      reconciliationCron: { not: null },
      nextReconciliationAt: { lte: new Date() },
    },
    select: { id: true },
    orderBy: { nextReconciliationAt: "asc" },
    take: 50,
  });
  for (const source of due) await queueSourceRefresh(source.id, { reconciliation: true });
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
  scopeColumns?: string[] | null;
  keysCheckCron?: string | null;
  keysSql?: string | null;
  sourceGroupId?: string;
}, opts?: { deferQueue?: boolean }) {
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
  assertDeleteDetection(input, columns.map(c => c.sqlName));
  const detect = input.mode === "extract";
  const scopeColumns = detect ? normalizeScopeColumns(input.scopeColumns) : null;
  const keysCheckCron = detect ? (input.keysCheckCron?.trim() || null) : null;

  const displayName = input.sourceKind === "table" ? input.sourceTable! : input.name?.trim();
  if (!displayName) throw new ApiError(400, "INVALID_SOURCE", "Fonte por consulta exige um nome");
  const tableName = sqlIdentifier(displayName);
  // Conflito checado ANTES de tocar o catalogo: o unique de targetTableId so estouraria
  // no create, depois de o upsert/replaceColumnCatalog ja ter sobrescrito a tabela existente.
  const existingTable = await prisma.datasetTable.findUnique({
    where: { datasetId_sqlName: { datasetId: dataset.id, sqlName: tableName } },
    select: { id: true },
  });
  if (existingTable) {
    const taken = await prisma.datasetSource.findFirst({ where: { targetTableId: existingTable.id }, select: { id: true } });
    if (taken) throw new ApiError(409, "SOURCE_ALREADY_EXISTS", `Ja existe uma fonte para a tabela "${tableName}" neste dataset`);
  }
  const table = await prisma.datasetTable.upsert({
    where: { datasetId_sqlName: { datasetId: dataset.id, sqlName: tableName } },
    update: { name: displayName },
    create: { datasetId: dataset.id, name: displayName, sqlName: tableName },
  });
  await replaceColumnCatalog(table.id, columns, 0n);

  let source;
  try {
  source = await prisma.datasetSource.create({
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
      scopeColumns: scopeColumns ? JSON.stringify(scopeColumns) : null,
      keysCheckCron,
      keysSql: detect && input.sourceKind === "query" ? (input.keysSql?.trim() || null) : null,
      nextKeysCheckAt: keysCheckCron ? nextRefreshFromCron(keysCheckCron) : null,
      lastStatus: input.mode === "live" ? "ready" : "queued",
      nextRefreshAt: input.mode === "extract" ? nextRefreshFromCron(input.refreshCron) : null,
    },
    include: { connection: true, targetTable: { include: { columns: { orderBy: { ordinal: "asc" } } } } },
  });
  } catch (e) {
    // Tabela recem-criada por este pedido nao deve ficar orfa se a fonte nao foi criada.
    if (!existingTable) await prisma.datasetTable.delete({ where: { id: table.id } }).catch(() => undefined);
    throw e;
  }
  if (input.mode === "extract" && !opts?.deferQueue) await queueSourceRefresh(source.id);
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
  reconciliationCron?: string | null;
  scopeColumns?: string[] | null;
  keysCheckCron?: string | null;
  keysSql?: string | null;
  sourceGroupId?: string;
}) {
  const sourceGroupId = input.sourceGroupId ?? randomUUID();
  const sources: Awaited<ReturnType<typeof createDatasetSource>>[] = [];
  try {
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
        reconciliationCron: input.reconciliationCron,
        scopeColumns: input.scopeColumns,
        keysCheckCron: input.keysCheckCron,
        keysSql: input.keysSql,
        sourceGroupId,
      }, { deferQueue: true }));
    }
  } catch (e) {
    // Tudo-ou-nada: desfaz as fontes ja criadas (nada foi enfileirado ainda).
    for (const s of sources) {
      await prisma.datasetSource.delete({ where: { id: s.id } }).catch(() => undefined);
    }
    throw e;
  }
  if (input.mode === "extract") for (const s of sources) await queueSourceRefresh(s.id);
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
    where: { id: source.id, ...NOT_RUNNING },
    data: { lastStatus: "running", lastError: null },
  });
  if (claimed.count === 0) {
    throw new ApiError(409, "SOURCE_REFRESH_IN_PROGRESS", "Já existe uma atualização em andamento para esta fonte (incremental ou reconciliação) — tente novamente em instantes");
  }
  const stageCols = columns.map(c => ({ name: c.sqlName, sqlType: c.sqlType, nullable: true }));
  const scopeColumns = parseScopeColumns(source.scopeColumns);
  const keysTable = `cw_keys_${idPrefix}`;

  try {
    await storageConn.createSchemaIfNotExists(schema);
    // Formato legado (soft delete): converte uma vez as linhas com cw_deleted_at em lapide + remocao fisica
    // (idempotente: 0 linhas depois). Depois, expira lapides antigas (TTL). Mesma trava "running".
    if (source.keyColumn) {
      // O merge nunca mais grava cw_deleted_at: depois de limpa, a tabela nao precisa ser varrida de novo
      // (o COUNT do legado era um scan completo a cada rodada). Lembra por processo; reinicio rechecaria uma vez.
      const legacyKey = `${source.dataset.storageServerId ?? "default"}:${schema}.${table}`;
      if (!LEGACY_CLEAN.has(legacyKey)) {
        const converted = await storageConn.convertLegacyDeleted(schema, table, source.keyColumn);
        if (converted) console.info(`[source-refresh] conversao de exclusoes legadas source=${source.id} linhas=${converted}`);
        LEGACY_CLEAN.add(legacyKey);
      }
      try {
        const ttl = await getTombstoneTtlDays();
        if (ttl > 0) await storageConn.purgeTombstones(schema, table, ttl);
      } catch (e) {
        console.warn(`[source-refresh] purga de lapides falhou source=${source.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // Cria tabela staging com os tipos canônicos das colunas
    await storageConn.dropTableIfExists(schema, stage);
    await storageConn.createTable(schema, stage, stageCols);

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
    // Chave nula/duplicada e checada sempre que ha keyColumn — inclusive na primeira
    // carga (full replace), para nao gravar uma chave inutilizavel.
    if (source.keyColumn) await assertKeyColumnSafe(storageConn, schema, stage, source.keyColumn);
    if (scopeColumns && useKeyMerge) {
      const unknown = scopeColumns.filter(c => !columns.some(col => col.sqlName === c));
      if (unknown.length) throw new ApiError(400, "SCOPE_COLUMN_UNKNOWN", `Coluna(s) de escopo inexistente(s) na fonte: ${unknown.join(", ")}`);
    }
    // fullSnapshot: só é seguro tratar "ausente da staging" como excluído na origem
    // quando a staging representa 100% do estado atual — mesma condição de
    // "unbounded" usada pra decidir o peso do job em queueSourceRefresh
    // (isBoundedSourceRun), fonte única de verdade pra não divergir.
    const fullSnapshot = !isBoundedSourceRun(source, reconciliation);
    const swap = await storageConn.atomicSwap(schema, stage, table, stageCols, {
      targetExists: hasTarget,
      keyColumn: useKeyMerge ? source.keyColumn : null,
      mergedName: useKeyMerge ? (reconciliation ? `cw_mgd_${idPrefix}_rc` : `cw_mgd_${idPrefix}`) : undefined,
      fullSnapshot,
      // Escopo so vale em incremental (numa rodada fullSnapshot todas as ausentes ja sao marcadas).
      ...(scopeColumns && useKeyMerge && !fullSnapshot ? { scopeColumns } : {}),
    });

    // Verificacao de chaves: pega carona no incremental (mesma trava "running"), depois do merge.
    // Falha aqui NAO derruba o merge ja concluido: vira aviso em lastError (status segue "completed").
    let keysCheckWarning: string | null = null;
    let keysRemoved = 0;
    let keysCheckDone = false;
    // Ja foi removido tudo que faltava se a staging e um snapshot completo (fullSnapshot): nada a verificar.
    const keysCheckDue = !reconciliation && !fullSnapshot && useKeyMerge && !!source.keysCheckCron?.trim()
      && (!source.nextKeysCheckAt || source.nextKeysCheckAt.getTime() <= Date.now());
    if (keysCheckDue) {
      try {
        const res = await runKeysCheck({ source, columns, storageConn, schema, table, keysTable, isMssql, quoteCol });
        keysCheckDone = true;
        keysRemoved = res.marked;
        console.info(`[source-refresh] keys check source=${source.id} keys=${res.keys} marked=${res.marked}`);
      } catch (e) {
        keysCheckWarning = `Verificacao de chaves: ${e instanceof ApiError ? `${e.code} - ` : ""}${e instanceof Error ? e.message : String(e)}`;
        console.warn(`[source-refresh] keys check falhou source=${source.id}: ${keysCheckWarning}`);
      } finally {
        await storageConn.dropTableIfExists(schema, keysTable).catch(() => undefined);
      }
    }

    const finalRowCount = await storageConn.countRows(schema, table);

    await replaceColumnCatalog(source.targetTable.id, columns, finalRowCount);
    await prisma.datasetSource.update({
      where: { id: source.id },
      data: {
        lastStatus: "completed",
        lastRowCount: finalRowCount,
        lastError: keysCheckWarning,
        lastRemovedCount: BigInt((swap?.removed ?? 0) + keysRemoved),
        lastRefreshedAt: new Date(),
        ...(keysCheckDue
          ? { nextKeysCheckAt: nextRefreshFromCron(source.keysCheckCron), ...(keysCheckDone ? { lastKeysCheckAt: new Date() } : {}) }
          : {}),
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

/**
 * Le SO as chaves da origem (tabela: `SELECT <chave> FROM <tabela>`; consulta: `keysSql`, uma coluna) para uma
 * tabela auxiliar no storage e REMOVE (com lapide) as linhas ausentes dela. `startedAt` vem do relogio do
 * storage (o mesmo de cw_synced_at) e a guarda `cw_synced_at < startedAt` protege linhas carregadas depois.
 * Nao loga valores de chave. A tabela auxiliar e removida pelo chamador (finally).
 */
async function runKeysCheck(o: {
  source: { id: string; keyColumn: string | null; sourceKind: string; sourceSchema: string | null; sourceTable: string | null; keysSql: string | null; connection: Parameters<typeof streamPostgresRows>[0] };
  columns: SourceColumn[]; storageConn: StorageConnection; schema: string; table: string; keysTable: string; isMssql: boolean; quoteCol: (c: string) => string;
}): Promise<{ keys: bigint; marked: number }> {
  const { source, columns, storageConn, schema, table, keysTable, isMssql, quoteCol } = o;
  const keyColumn = source.keyColumn!;
  const keyCol = columns.find(c => c.sqlName === keyColumn) ?? columns.find(c => c.originalName === keyColumn);
  if (!keyCol) throw new ApiError(400, "KEY_COLUMN_UNKNOWN", `Coluna-chave "${keyColumn}" nao existe na fonte`);
  let keysQuery: string;
  if (source.sourceKind === "table") {
    keysQuery = `SELECT ${quoteCol(keyCol.originalName)} FROM ${isMssql ? quotedMssqlTable(source.sourceSchema!, source.sourceTable!) : quotedPgTable(source.sourceSchema!, source.sourceTable!)}`;
  } else {
    if (!source.keysSql?.trim()) throw new ApiError(400, "KEYS_SQL_REQUIRED", "Fonte sem consulta de chaves configurada");
    keysQuery = source.keysSql;
  }
  const keyDef = [{ name: keyCol.sqlName, sqlType: keyCol.sqlType, nullable: true }];
  const startedAt = await storageConn.serverNow();
  await storageConn.dropTableIfExists(schema, keysTable);
  await storageConn.createTable(schema, keysTable, keyDef);
  let keys = 0n;
  for await (const rows of (isMssql ? streamMssqlRows(source.connection, keysQuery, 5000) : streamPostgresRows(source.connection, keysQuery, 5000))) {
    const batch: (string | null)[][] = [];
    for (const row of rows) {
      const values = Object.values(row);
      if (values.length !== 1) throw new ApiError(400, "KEYS_SQL_INVALID", "A consulta de chaves deve retornar exatamente uma coluna");
      const v = convertSourceValue(values[0], keyCol.sqlType);
      if (v != null) batch.push([v]);
    }
    await storageConn.bulkInsert(schema, keysTable, keyDef, batch);
    keys += BigInt(batch.length);
  }
  if (keys === 0n) throw new ApiError(409, "KEYS_CHECK_UNSAFE", "Verificacao de chaves abortada: a origem retornou zero chaves (nada foi removido)");
  const res = await storageConn.markMissingKeysDeleted(schema, table, keyCol.sqlName, keysTable, startedAt, { maxRatio: KEYS_CHECK_MAX_RATIO });
  if (res.aborted) {
    throw new ApiError(409, "KEYS_CHECK_UNSAFE", `Verificacao de chaves abortada: ${res.candidates} de ${res.live} linhas vivas seriam removidas (limite ${Math.round(KEYS_CHECK_MAX_RATIO * 100)}%); nada foi removido`);
  }
  return { keys, marked: res.marked };
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
