import { randomUUID } from "crypto";
import { Cron } from "croner";
import { prisma } from "@/server/db";
import { withAdvisoryLock } from "@/server/db/advisory-lock";
import { sqlPool, ensureSchema } from "@/server/azure/sql";
import { getStorageConnection, type StorageConnection } from "@/server/storage/connection";
import { sqlIdentifier } from "@/server/security/naming";
import { ApiError } from "@/server/http";
import { KEYS_CHECK_MAX_RATIO, keysCheckExceeds } from "@/server/storage/delete-detection";
import { evaluateLoad, getIntegritySettings, IntegrityError, type Evaluation } from "@/server/integrity/policy";
import { auditIntegrity, evaluationDetail, recordLedger } from "@/server/integrity/ledger";
import { queryColumns, quotedPgTable, sourceClockPg, streamPostgresRows, tableColumns, type SourceColumn } from "./postgres";
import { queryColumnsMssql, quotedMssqlTable, sourceClockMssql, streamMssqlRows, tableColumnsMssql } from "./mssql";
import { compareWithCatalog, convertSourceValue, type ResolvedColumn } from "./source-values";
import { WatermarkTracker, buildDeltaPredicate, compareWatermark, deltaCap, deltaKindOf, isFutureWatermark, normalizeWatermark } from "./source-delta";
import {
  LEASE_HEARTBEAT_MS, defaultReconciliationCron, deletionCoverageWarning, extractKeysWarning, getSourceSettings, isSkipWarning,
  leaseMarker, previousKeysSkips, resolveColumn, withSkipCount,
} from "./source-guards";

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

/**
 * Fonte como a API devolve, com o campo derivado `integrityWarnings` (FON-06): avisos visiveis de que algo pode estar
 * deixando a tabela desatualizada/com linhas fantasma (ex.: fonte com chave sem nenhuma deteccao de exclusoes).
 */
export function exposeSource<T extends object>(source: T): T & { integrityWarnings: string[] } {
  const w = deletionCoverageWarning(source as Parameters<typeof deletionCoverageWarning>[0]);
  return { ...source, integrityWarnings: w ? [w] : [] };
}

/**
 * Valida a deteccao de exclusoes (soft delete) contra o estado RESULTANTE da fonte. Fonte live ignora tudo (os
 * campos sao zerados pelo chamador). Exclusoes: exige chave; fonte por consulta exige `keysSql` (uma coluna);
 * fonte por tabela nao aceita `keysSql` (as chaves sao lidas direto da tabela).
 */
export function assertDeleteDetection(i: {
  mode: string; sourceKind: string; keyColumn?: string | null; detectDeletions?: boolean | null;
  keysSql?: string | null; keysMinIntervalMinutes?: number | null;
}): void {
  if (i.mode === "live") return;
  const interval = i.keysMinIntervalMinutes;
  if (interval != null && (!Number.isInteger(interval) || interval < 1 || interval > 525_600)) {
    throw new ApiError(400, "INVALID_KEYS_INTERVAL", "Intervalo minimo de leitura de chaves deve ser um inteiro entre 1 e 525600 minutos");
  }
  if (i.keysSql?.trim() && i.sourceKind !== "query") {
    throw new ApiError(400, "KEYS_SQL_NOT_ALLOWED", "Consulta de chaves so existe em fontes por consulta (em tabela as chaves sao lidas direto da tabela)");
  }
  if (!i.detectDeletions) return;
  if (!i.keyColumn?.trim()) throw new ApiError(400, "DELETE_DETECTION_REQUIRES_KEY", "Deteccao de exclusoes exige coluna-chave");
  if (i.sourceKind === "query" && !i.keysSql?.trim()) {
    throw new ApiError(400, "KEYS_SQL_REQUIRED", "Fontes por consulta exigem a consulta de chaves (uma coluna, mesmo formato da coluna-chave) para habilitar a deteccao de exclusoes");
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

/**
 * FAIXA (peso do job) de uma rodada de fonte — decide em qual worker ela roda (ver src/worker/claim.ts e as faixas em
 * src/lib/worker-presets.ts): "fast" = peso 0 (faixa de syncs rápidos), "long" = peso 2 (faixa de syncs longos, gateada
 * por max_heavy_jobs). Antes o peso vinha só de bounded/unbounded, e isso invertia o custo real: a incremental da ADL
 * (janelada, "bounded", peso 0) levava ~5 min e passava na frente de tudo, enquanto as cópias completas de tabelas
 * pequenas ("unbounded", peso 2) levavam ~4 s. Agora vale a duração observada.
 *
 * Ordem de decisão: reconciliação é sempre longa; com histórico, a média móvel da duração (>= LONG_RUN_MS = longa);
 * sem histórico mas com contagem de linhas da última carga, o tamanho (>= LONG_ROWS_HINT = longa); sem nada, a regra
 * antiga (bounded = rápida, unbounded = longa). `isBoundedSourceRun` continua valendo para o `fullSnapshot` (exclusões).
 */
export const LONG_RUN_MS = 2 * 60_000;
export const LONG_ROWS_HINT = 500_000;
export type SourceLane = "fast" | "long";

export function classifySourceLane(
  source: { sourceKind: string; deltaColumn: string | null; lastDeltaValue: string | null; keyColumn: string | null; avgRunMs?: number | null; lastRowCount?: bigint | number | null },
  reconciliation: boolean,
): SourceLane {
  if (reconciliation) return "long";
  if (source.avgRunMs != null) return source.avgRunMs >= LONG_RUN_MS ? "long" : "fast";
  if (source.lastRowCount != null) return Number(source.lastRowCount) >= LONG_ROWS_HINT ? "long" : "fast";
  return isBoundedSourceRun(source, reconciliation) ? "fast" : "long";
}

export const laneWeight = (lane: SourceLane): 0 | 2 => (lane === "long" ? 2 : 0);

/** Média móvel exponencial (alpha 0,3) da duração das execuções incrementais bem-sucedidas; 1ª medição vira a média. */
export function nextAvgRunMs(prev: number | null | undefined, elapsedMs: number): number {
  const d = Math.max(0, Math.min(Math.round(elapsedMs), 2_000_000_000));
  return prev == null ? d : Math.round(0.7 * prev + 0.3 * d);
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
        select: { sourceKind: true, deltaColumn: true, lastDeltaValue: true, keyColumn: true, avgRunMs: true, lastRowCount: true, dataset: { select: { storageServerId: true } } },
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
      if (existing.status === "QUEUED") await markQueued(datasetSourceId);
      return existing;
    }
    const weight = laneWeight(classifySourceLane(source, reconciliation));
    // Bucket "__default__" pro storage padrão (storageServerId null no dataset) —
    // nunca grava NULL aqui: NULL no Job.storageServerId é reservado pra "job não é
    // do tipo SOURCE_REFRESH" (ver claim() em worker/index.ts), não "storage padrão".
    const storageBucket = source.dataset.storageServerId ?? "__default__";
    const [job] = await prisma.$transaction([
      prisma.job.create({ data: { type: "SOURCE_REFRESH", payloadJson: JSON.stringify({ datasetSourceId, reconciliation }), maxAttempts: 3, weight, storageServerId: storageBucket } }),
      // Nao sobrescreve uma fonte "running" (derrubaria a trava mutua do refresh).
      ...queuedUpdates(datasetSourceId),
    ]);
    return job;
  });
}

const SKIPS_MARK = "[skips=";
/**
 * "queued" limpava lastError, e com ele o contador de verificacoes de exclusao ignoradas (que vive no aviso KEYS_*[skips=N]).
 * Aqui o aviso com contador e preservado; qualquer outro erro antigo continua sendo limpo como antes.
 */
function queuedUpdates(id: string) {
  return [
    prisma.datasetSource.updateMany({
      where: { AND: [{ id }, NOT_RUNNING, { OR: [{ lastError: null }, { NOT: { lastError: { contains: SKIPS_MARK } } }] }] },
      data: { lastStatus: "queued", lastError: null },
    }),
    prisma.datasetSource.updateMany({
      where: { AND: [{ id }, NOT_RUNNING, { lastError: { contains: SKIPS_MARK } }] },
      data: { lastStatus: "queued" },
    }),
  ];
}
const markQueued = (id: string) => Promise.all(queuedUpdates(id));

/**
 * Enfileira toda fonte com refreshCron vencido. O teto de quantos syncs rodam ao
 * mesmo tempo por storage (maxSyncsPerStorage) NÃO é checado aqui — o job sempre
 * entra na fila; quem decide se/quando ele começa a rodar é o claim() do worker
 * (mesmo padrão de weight/maxHeavyJobs). Checar isso aqui, na hora de enfileirar,
 * fazia uma fonte "perder a vaga" repetidamente sem nunca chegar a existir como job.
 */
const ENQUEUE_BATCH = 50;
const ENQUEUE_SCAN = 1000;

/**
 * Fome de fontes (FON-16): antes pegava sempre as 50 mais antigas; enquanto elas ficavam com job na fila/rodando (o
 * nextRefreshAt so avanca ao terminar), as fontes alem da 50a nunca eram enfileiradas. Agora varre mais fundo, PULA as que
 * ja tem job ativo (do mesmo tipo) e enfileira ate 50 NOVAS por passada, sempre das mais atrasadas para as menos.
 */
async function enqueueDue(kind: "refresh" | "reconciliation") {
  const recon = kind === "reconciliation";
  const [due, active] = await Promise.all([
    prisma.datasetSource.findMany({
      where: recon
        ? { active: true, mode: "extract", reconciliationCron: { not: null }, nextReconciliationAt: { lte: new Date() } }
        : { active: true, mode: "extract", refreshCron: { not: null }, nextRefreshAt: { lte: new Date() } },
      select: { id: true },
      orderBy: recon ? { nextReconciliationAt: "asc" } : { nextRefreshAt: "asc" },
      take: ENQUEUE_SCAN,
    }),
    prisma.job.findMany({ where: { type: "SOURCE_REFRESH", status: { in: ["QUEUED", "RUNNING"] } }, select: { payloadJson: true } }),
  ]);
  const busy = new Set<string>();
  for (const j of active ?? []) {
    try {
      const p = JSON.parse(j.payloadJson ?? "{}") as { datasetSourceId?: string; reconciliation?: boolean };
      if (p.datasetSourceId && !!p.reconciliation === recon) busy.add(p.datasetSourceId);
    } catch { /* payload ilegivel: ignora */ }
  }
  let queued = 0;
  for (const source of due) {
    if (busy.has(source.id)) continue;
    await queueSourceRefresh(source.id, recon ? { reconciliation: true } : undefined);
    if (++queued >= ENQUEUE_BATCH) break;
  }
}

export async function enqueueDueSourceRefreshes() {
  await enqueueDue("refresh");
}

/** Espelha enqueueDueSourceRefreshes, mas para o cron secundário de reconciliação
 * (full snapshot periódico — ver refreshDatasetSource com opts.reconciliation). */
export async function enqueueDueReconciliations() {
  await enqueueDue("reconciliation");
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
  detectDeletions?: boolean | null;
  keysSql?: string | null;
  keysMinIntervalMinutes?: number | null;
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
  assertDeleteDetection(input);
  const detect = input.mode === "extract" && !!input.detectDeletions;
  // FON-06: fonte NOVA com chave e sem deteccao de exclusoes ganha reconciliacao diaria (full snapshot) por padrao; sem isso,
  // linhas apagadas na origem ficariam vivas para sempre. Escolha explicita (inclusive null) e respeitada. Fontes existentes
  // NAO sao alteradas (so sinalizadas em `integrityWarnings`).
  const reconciliationCron = defaultReconciliationCron({
    mode: input.mode, keyColumn: input.keyColumn, detectDeletions: input.detectDeletions, reconciliationCron: input.reconciliationCron,
    sourceKind: input.sourceKind, sourceSqlReconciliation: input.sourceSqlReconciliation,
  }) ?? input.reconciliationCron;

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
      reconciliationCron: input.mode === "live" ? null : (reconciliationCron ?? null),
      sourceSqlReconciliation: input.sourceKind === "query" ? (input.sourceSqlReconciliation ?? null) : null,
      nextReconciliationAt: input.mode === "extract" ? nextRefreshFromCron(reconciliationCron) : null,
      detectDeletions: detect,
      keysSql: detect && input.sourceKind === "query" ? (input.keysSql?.trim() || null) : null,
      keysMinIntervalMinutes: detect ? (input.keysMinIntervalMinutes ?? null) : null,
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
  detectDeletions?: boolean | null;
  keysMinIntervalMinutes?: number | null;
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
        detectDeletions: input.detectDeletions,
        keysMinIntervalMinutes: input.keysMinIntervalMinutes,
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
    include: { dataset: true, connection: true, targetTable: { include: { columns: { orderBy: { ordinal: "asc" } } } } },
  });
  if (!source || !source.active) throw new ApiError(404, "SOURCE_NOT_FOUND", "Fonte não encontrada");
  if (source.mode !== "extract") throw new ApiError(400, "INVALID_SOURCE_MODE", "Apenas fontes extract podem ser atualizadas");
  if (!source.targetTable) throw new ApiError(400, "SOURCE_NO_TARGET_TABLE", "Fonte sem tabela de destino");
  if (reconciliation && source.sourceKind === "query" && !source.sourceSqlReconciliation?.trim()) {
    throw new ApiError(400, "RECONCILIATION_SQL_REQUIRED", "Fonte sem consulta de reconciliacao configurada");
  }

  const isMssql = source.connection.provider === "mssql";
  const settings = await getSourceSettings();

  // Reconciliacao em fonte por consulta usa o SQL sem filtro de data (sourceSqlReconciliation),
  // nunca o sourceSql janelado normal — ja validado acima que existe quando reconciliation=true.
  const effectiveSourceSql = reconciliation && source.sourceKind === "query" ? source.sourceSqlReconciliation! : source.sourceSql!;
  const baseTableQuery = source.sourceKind === "table"
    ? `SELECT * FROM ${isMssql ? quotedMssqlTable(source.sourceSchema!, source.sourceTable!) : quotedPgTable(source.sourceSchema!, source.sourceTable!)}`
    : effectiveSourceSql;
  const quoteCol = (col: string) => isMssql ? `[${col.replace(/]/g, "]]")}]` : `"${col.replace(/"/g, '""')}"`;

  const storageConn = await getStorageConnection(source.dataset.storageServerId);
  const schema = source.dataset.schemaName;
  const table = source.targetTable.sqlName;
  const idPrefix = source.id.replaceAll("-", "").slice(0, 20);
  // Sufixo distinto pro staging/merge de reconciliação — incremental e reconciliação
  // da MESMA fonte nunca devem tocar a mesma tabela intermediária, mesmo que a trava
  // abaixo falhe por algum motivo (defesa em profundidade).
  const stage = reconciliation ? `cw_src_${idPrefix}_rc` : `cw_src_${idPrefix}`;
  let rowCount = 0n;

  // Trava mútua com LEASE: incremental e reconciliação da mesma fonte nunca podem rodar ao mesmo tempo (colidiriam na mesma
  // tabela final via atomicSwap). UPDATE condicional atômico — se outra rodada já está "running", 0 linhas são afetadas.
  // O dono grava um marcador (lease:<uuid>) em lastError e renova `updatedAt` a cada minuto; se o dono morreu (queda do
  // worker) e ninguém renova há `staleLeaseMinutes`, a próxima rodada ASSUME a trava em vez de falhar em 409 para sempre.
  const lease = leaseMarker(randomUUID());
  let claimed = await prisma.datasetSource.updateMany({
    where: { id: source.id, ...NOT_RUNNING },
    data: { lastStatus: "running", lastError: lease },
  });
  if (claimed.count === 0) {
    claimed = await prisma.datasetSource.updateMany({
      where: { id: source.id, lastStatus: "running", updatedAt: { lt: new Date(Date.now() - settings.staleLeaseMinutes * 60_000) } },
      data: { lastStatus: "running", lastError: lease },
    });
    if (claimed.count > 0) console.warn(`[source-refresh] assumindo trava de execucao sem renovacao ha mais de ${settings.staleLeaseMinutes} min (dono provavelmente morreu) source=${source.id}`);
  }
  if (claimed.count === 0) {
    throw new ApiError(409, "SOURCE_REFRESH_IN_PROGRESS", "Já existe uma atualização em andamento para esta fonte (incremental ou reconciliação) — tente novamente em instantes");
  }
  const runStartedAt = Date.now(); // duração real da rodada (a partir daqui, já com a trava), para classificar a faixa
  const keysTable = `cw_keys_${idPrefix}`;

  let leaseLost = false;
  const heartbeat = setInterval(() => {
    prisma.datasetSource.updateMany({
      where: { id: source.id, lastStatus: "running", lastError: lease },
      data: { lastStatus: "running", updatedAt: new Date() },
    }).then(r => { if (r.count === 0) leaseLost = true; }).catch(() => undefined);
  }, LEASE_HEARTBEAT_MS);
  heartbeat.unref?.();
  const assertLease = () => {
    if (leaseLost) throw new ApiError(409, "SOURCE_LEASE_LOST", "Outra execucao assumiu a trava desta fonte (esta ficou sem renovar); a tabela nao foi alterada por esta rodada");
  };

  try {
    // ── Estrutura da origem x catalogo (FON-11/15) e resolucao de colunas (FON-14) ──────────────────────────────────────
    const rawColumns: SourceColumn[] = source.sourceKind === "table"
      ? (isMssql ? await tableColumnsMssql(source.connection, source.sourceSchema!, source.sourceTable!) : await tableColumns(source.connection, source.sourceSchema!, source.sourceTable!))
      : (isMssql ? await queryColumnsMssql(source.connection, effectiveSourceSql) : await queryColumns(source.connection, effectiveSourceSql));
    const catalog = (source.targetTable.columns as { sqlName: string; sqlType: string }[] | undefined)?.map(c => ({ sqlName: c.sqlName, sqlType: c.sqlType }));
    const cmp = compareWithCatalog(rawColumns as ResolvedColumn[], catalog);
    const columns = cmp.columns as SourceColumn[];
    const stageCols = columns.map(c => ({ name: c.sqlName, sqlType: c.sqlType, nullable: true }));

    await storageConn.createSchemaIfNotExists(schema);
    const hasTarget = await storageConn.tableExists(schema, table);
    const schemaChange = hasTarget && cmp.changed;
    const notes: string[] = [];

    const keyCol = source.keyColumn ? resolveColumn(columns, source.keyColumn) : null;
    if (source.keyColumn && !keyCol) throw new ApiError(400, "KEY_COLUMN_UNKNOWN", `Coluna-chave "${source.keyColumn}" nao existe na fonte (colunas: ${columns.map(c => c.originalName).join(", ")})`);
    if (keyCol?.legacyRound) throw new ApiError(400, "KEY_COLUMN_TYPE_UNSAFE", `Coluna-chave "${source.keyColumn}" e numerica de ponto flutuante gravada em DECIMAL(18,4): chaves diferentes colidem ao arredondar. Recrie a fonte (a coluna passa a ser guardada como texto exato) ou use uma chave inteira.`);
    const keyStorage = keyCol?.sqlName ?? null;

    const deltaCol = source.deltaColumn && source.sourceKind === "table" ? resolveColumn(columns, source.deltaColumn) : null;
    if (source.deltaColumn && source.sourceKind === "table" && !deltaCol) throw new ApiError(400, "DELTA_COLUMN_UNKNOWN", `Coluna de incremento "${source.deltaColumn}" nao existe na fonte (colunas: ${columns.map(c => c.originalName).join(", ")})`);
    // Incremental exige chave (upsert). Delta SEM chave sempre lê a tabela inteira e substitui: correto, so mais caro.
    const trackDelta = !!(deltaCol && keyCol);
    const kind = deltaCol ? deltaKindOf(deltaCol.sqlType) : "text";

    // Limite da marca d'agua = relogio da origem + tolerancia (FON-01). Falha ao ler o relogio cai no relogio local (UTC).
    let cap: string | null = null;
    if (trackDelta && kind === "temporal") {
      let now: Date;
      try { now = await (isMssql ? sourceClockMssql(source.connection) : sourceClockPg(source.connection)); } catch { now = new Date(); }
      cap = deltaCap(now, settings.futureToleranceHours);
    }

    let wm: string | null = null;
    let poisoned = false;
    if (trackDelta && !reconciliation && source.lastDeltaValue) {
      wm = normalizeWatermark(source.lastDeltaValue, kind);
      if (wm == null) {
        poisoned = true;
        notes.push(`DELTA_RESET: a marca d'agua gravada ("${source.lastDeltaValue.slice(0, 40)}") e ilegivel para o tipo da coluna; a tabela foi recarregada integralmente`);
      } else if (isFutureWatermark(wm, kind, cap)) {
        poisoned = true;
        notes.push(`DELTA_RESET: a marca d'agua gravada (${wm}) estava no futuro e congelaria a fonte; a tabela foi recarregada integralmente e a marca recalculada`);
      }
    }
    if (schemaChange) {
      if (source.sourceKind === "query" && !reconciliation) {
        // Consulta com janela nao le a tabela inteira: recarregar so com ela apagaria o historico. So a reconciliacao (consulta sem janela) pode.
        const canRecon = !!source.sourceSqlReconciliation?.trim();
        if (canRecon) await queueSourceRefresh(source.id, { reconciliation: true }).catch(() => undefined);
        throw new ApiError(409, "SOURCE_SCHEMA_CHANGED", `A estrutura da origem mudou (${cmp.changes.join("; ")}). Esta fonte usa uma consulta com janela e nao pode se recarregar sozinha sem perder o historico; ${canRecon ? "uma reconciliacao foi enfileirada e recarrega a tabela inteira" : "cadastre a consulta de reconciliacao e rode uma reconciliacao para recarregar a tabela inteira"}. A tabela anterior foi mantida.`);
      }
      notes.push(`SCHEMA_CHANGED: a estrutura da origem mudou (${cmp.changes.join("; ")}); a tabela foi recarregada integralmente com a nova estrutura`);
    }

    // Delta: so lê linhas a partir da marca (menos a janela de sobreposicao); so fonte por tabela com chave e marca valida.
    // Numa rodada de reconciliacao, o delta e ignorado de proposito: le a tabela inteira (sem WHERE) para detectar exclusoes.
    const useDelta = trackDelta && !reconciliation && wm != null && !poisoned && !schemaChange;
    const query = useDelta
      ? `${baseTableQuery} WHERE ${buildDeltaPredicate({ kind, quotedColumn: quoteCol(deltaCol!.originalName), watermark: wm!, dialect: isMssql ? "mssql" : "postgres", lookbackMinutes: settings.lookbackMinutes })}`
      : baseTableQuery;

    await storageConn.dropTableIfExists(schema, stage);
    await storageConn.createTable(schema, stage, stageCols);

    const tracker = new WatermarkTracker(kind, cap);
    const deltaIdx = trackDelta ? columns.findIndex(c => c.sqlName === deltaCol!.sqlName) : -1;
    const STREAM_BATCH = 1000;
    for await (const rows of (isMssql ? streamMssqlRows(source.connection, query, STREAM_BATCH) : streamPostgresRows(source.connection, query, STREAM_BATCH))) {
      assertLease();
      const bulkRows = rows.map(row => columns.map(c => convertSourceValue(row[c.originalName], c.sqlType, { column: c.sqlName, legacyRound: c.legacyRound })));
      if (deltaIdx >= 0) for (const r of bulkRows) { const v = r[deltaIdx]; tracker.push(v == null ? null : normalizeWatermark(v, kind)); }
      await storageConn.bulkInsert(schema, stage, stageCols, bulkRows);
      rowCount += BigInt(rows.length);
    }
    assertLease();

    // Nova marca (do valor CRU lido, nao de Date do storage): nunca recua e nunca passa do limite do relogio da origem.
    let newDeltaValue: string | null | undefined = undefined;
    if (trackDelta) {
      if (tracker.max != null) newDeltaValue = useDelta && wm != null && compareWatermark(tracker.max, wm, kind) < 0 ? undefined : tracker.max;
      else if (poisoned) newDeltaValue = null; // recarga completa sem nenhum valor valido: recomeca do zero na proxima
      const w = tracker.warning(deltaCol!.sqlName);
      if (w) notes.push(w);
    }

    // Swap atômico (upsert ou replace). Upsert por keyColumn funciona para qualquer
    // sourceKind (table ou query) — independe de haver deltaColumn/fetch incremental,
    // que é exclusivo de sourceKind "table". Para "query", o corte incremental (janela,
    // filtro de data etc.) fica embutido no próprio SQL cadastrado pelo usuário.
    // Estrutura mudou: substitui a tabela inteira (o merge escreveria colunas novas/tipos novos sobre linhas antigas = NULLs).
    const useKeyMerge = !!keyCol && hasTarget && !schemaChange;
    // Chave nula/duplicada e checada sempre que ha keyColumn — inclusive na primeira
    // carga (full replace), para nao gravar uma chave inutilizavel.
    if (keyStorage) await assertKeyColumnSafe(storageConn, schema, stage, keyStorage);
    // fullSnapshot: só é seguro tratar "ausente da staging" como excluído na origem
    // quando a staging representa 100% do estado atual (reconciliacao, ou tabela lida inteira).
    const fullSnapshot = reconciliation || (source.sourceKind === "table" && !useDelta);

    // Guarda de integridade (FON-05/07): leitura que substitui o ESTADO INTEIRO (fullSnapshot, reconciliacao, sem chave, recarga
    // por mudanca de estrutura) e vem vazia ou com queda grande contra a versao anterior NAO troca a tabela: a anterior fica.
    const fullState = fullSnapshot || !useKeyMerge;
    if (fullState && hasTarget) {
      const prevRows = await livePrevRows(storageConn, schema, table, Number(source.lastRowCount ?? 0n));
      const evaluation: Evaluation = evaluateLoad({ kind: "source", fullState: true, parsedRows: Number(rowCount), prevRows, scheduled: true }, await getIntegritySettings());
      if (evaluation.verdict === "FAILED") throw new IntegrityError(evaluation);
      if (evaluation.verdict === "SUSPECT") notes.push(`INTEGRITY_SUSPECT: ${evaluation.reasons.map(r => `${r.code}: ${r.message}`).join(" ")}`);
    }

    // Deteccao de exclusoes (soft delete): passo do PROPRIO incremental — a lista completa de chaves da origem vai
    // para uma tabela auxiliar e o merge (mesma transacao do swap) marca/desmarca. Opt-in; sem a flag, nada muda.
    const keysDue = !!source.detectDeletions && !!keyCol && useKeyMerge && !fullSnapshot
      && (source.keysMinIntervalMinutes == null || !source.lastKeysCheckAt
        || Date.now() - source.lastKeysCheckAt.getTime() >= source.keysMinIntervalMinutes * 60_000);
    let keysWarning: string | null = null;
    let keysApplied = false;
    let swapKeys: { keysTable: string; keysBefore: Date } | null = null;
    let swap: { marked: number };
    try {
      if (keysDue) {
        const startedAt = await storageConn.serverNow();
        // Falha ao LER as chaves (rede, consulta invalida) nao pode parar o fluxo de dados: como nas travas, pula a
        // marcacao, aplica o delta e deixa o aviso visivel em lastError.
        let read: Awaited<ReturnType<typeof readSourceKeys>> | null = null;
        try {
          read = await readSourceKeys({ source, keyCol: keyCol!, storageConn, schema, keysTable, isMssql, quoteCol });
        } catch (e) {
          keysWarning = `KEYS_READ_FAILED: deteccao de exclusoes ignorada: ${e instanceof ApiError ? `${e.code} - ` : ""}${e instanceof Error ? e.message : String(e)} (nenhuma linha foi marcada como excluida; as linhas alteradas foram aplicadas)`;
        }
        if (!read) {
          // aviso ja definido acima
        } else if (read.keys === 0n) {
          keysWarning = "KEYS_CHECK_EMPTY: deteccao de exclusoes ignorada: a origem retornou zero chaves (nenhuma linha foi marcada como excluida; as linhas alteradas foram aplicadas)";
        } else {
          // Como na leitura das chaves: falhar em CONTAR (timeout do storage, rede) nao pode parar o fluxo de dados —
          // sem a contagem de guarda a marcacao nao e segura, entao pula so a marcacao e aplica o delta.
          try {
            const cnt = await storageConn.countMissingKeys(schema, table, keyStorage!, keysTable, startedAt);
            if (keysCheckExceeds(cnt, KEYS_CHECK_MAX_RATIO)) {
              keysWarning = `KEYS_CHECK_UNSAFE: deteccao de exclusoes ignorada: ${cnt.candidates} de ${cnt.live} linhas vivas seriam marcadas (limite ${Math.round(KEYS_CHECK_MAX_RATIO * 100)}%); nenhuma foi marcada (as linhas alteradas foram aplicadas)`;
            } else {
              swapKeys = { keysTable, keysBefore: startedAt };
            }
          } catch (e) {
            keysWarning = `KEYS_CHECK_FAILED: deteccao de exclusoes ignorada: ${e instanceof Error ? e.message : String(e)} (nenhuma linha foi marcada como excluida; as linhas alteradas foram aplicadas)`;
          }
        }
        if (keysWarning) console.warn(`[source-refresh] ${keysWarning} source=${source.id}`);
      }
      assertLease();
      swap = await storageConn.atomicSwap(schema, stage, table, stageCols, {
        targetExists: hasTarget,
        keyColumn: useKeyMerge ? keyStorage : null,
        mergedName: useKeyMerge ? (reconciliation ? `cw_mgd_${idPrefix}_rc` : `cw_mgd_${idPrefix}`) : undefined,
        fullSnapshot,
        ...(swapKeys ?? {}),
      });
      keysApplied = !!swapKeys;
    } finally {
      if (keysDue) await storageConn.dropTableIfExists(schema, keysTable).catch(() => undefined);
    }

    // Verificacoes de exclusao ignoradas SEGUIDAS (FON-12): o contador vive no proprio aviso (KEYS_*[skips=N]) em lastError.
    // Rodada sem verificacao devida (intervalo minimo) carrega o aviso; reconciliacao/verificacao aplicada zera.
    const prevSkips = previousKeysSkips(source.lastError);
    let keysSkips = 0;
    if (keysDue && isSkipWarning(keysWarning)) {
      keysSkips = prevSkips + 1;
      keysWarning = withSkipCount(keysWarning!, keysSkips);
    } else if (!keysDue && !fullSnapshot && !!source.detectDeletions && prevSkips > 0) {
      keysWarning = extractKeysWarning(source.lastError);
      keysSkips = prevSkips;
    }
    const escalateAfter = settings.keysEscalateAfter;
    const escalated = escalateAfter > 0 && keysSkips >= escalateAfter;
    if (escalated) {
      notes.unshift(`KEYS_CHECK_ESCALATED: a deteccao de exclusoes foi ignorada em ${keysSkips} rodadas seguidas; linhas apagadas na origem podem continuar vivas nesta tabela. Corrija a causa (veja o aviso abaixo) ou rode uma reconciliacao`);
    }

    const finalRowCount = await storageConn.countRows(schema, table);

    await replaceColumnCatalog(source.targetTable.id, columns, finalRowCount);
    const lastError = [...notes, keysWarning].filter(Boolean).join(" | ") || null;
    await prisma.datasetSource.update({
      where: { id: source.id },
      data: {
        lastStatus: escalated ? "failed" : "completed",
        lastRowCount: finalRowCount,
        lastError,
        lastRemovedCount: BigInt(swap.marked),
        lastRefreshedAt: new Date(),
        ...(keysApplied ? { lastKeysCheckAt: new Date() } : {}),
        // Só rodadas incrementais entram na média: a reconciliação é sempre "longa" e distorceria a classificação.
        ...(reconciliation ? {} : { avgRunMs: nextAvgRunMs(source.avgRunMs, Date.now() - runStartedAt) }),
        ...(reconciliation
          ? { nextReconciliationAt: nextRefreshFromCron(source.reconciliationCron), lastReconciliationAt: new Date() }
          : { nextRefreshAt: nextRefreshFromCron(source.refreshCron) }),
        ...(newDeltaValue !== undefined ? { lastDeltaValue: newDeltaValue } : {}),
      },
    });
    // Escalada: dispara uma reconciliacao (leitura completa, marca exclusoes de verdade) quando ela e possivel e segura.
    if (escalated && escalateAfter > 0 && keysSkips % escalateAfter === 0 && (source.sourceKind === "table" || !!source.sourceSqlReconciliation?.trim())) {
      await queueSourceRefresh(source.id, { reconciliation: true }).catch((e) => console.warn(`[source-refresh] nao foi possivel enfileirar a reconciliacao automatica source=${source.id}: ${e instanceof Error ? e.message : e}`));
    }
    // Livro de integridade: uma linha por rodada (esperado x lido x gravado x anterior). Nunca derruba a carga.
    await recordLedger({
      kind: "source", outcome: "COMPLETED",
      verdict: escalated || notes.some((n) => n.startsWith("INTEGRITY_SUSPECT")) ? "SUSPECT" : "OK",
      datasetId: source.datasetId, tableId: source.targetTable.id, sourceId: source.id, tableName: table,
      mode: reconciliation ? "reconciliation" : (fullState ? "full" : "incremental"),
      parsedRows: Number(rowCount), physicalRows: Number(finalRowCount), prevRows: Number(source.lastRowCount ?? 0n),
      detail: { notes, keysSkips },
    });
    return { rowCount: finalRowCount };
  } catch (e) {
    await storageConn.dropTableIfExists(schema, stage).catch(() => undefined);
    // Trava perdida: outra rodada e a dona do estado da fonte; nao sobrescreve o status dela.
    if (leaseLost) throw e;
    const message = e instanceof Error ? e.message : String(e);
    // A tentativa que falha também vai para o livro (com o motivo estruturado se for a barra de integridade) e, nesse caso, para a auditoria.
    const failedEntry = {
      kind: "source" as const, outcome: "FAILED" as const, verdict: (e instanceof IntegrityError ? e.evaluation.verdict : "FAILED") as "FAILED" | "SUSPECT" | "OK",
      datasetId: source.datasetId, tableId: source.targetTable?.id ?? null, sourceId: source.id, tableName: source.targetTable?.sqlName ?? null,
      mode: reconciliation ? "reconciliation" : "incremental", prevRows: Number(source.lastRowCount ?? 0n),
      detail: e instanceof IntegrityError ? evaluationDetail(e.evaluation) : { error: message.slice(0, 500) },
    };
    await recordLedger(failedEntry);
    if (e instanceof IntegrityError) await auditIntegrity({ ...failedEntry, resourceId: source.id });
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
  } finally {
    clearInterval(heartbeat);
  }
}

/** Linhas VIVAS da tabela de destino (sem as marcadas como excluidas); sem a coluna interna, cai no ultimo total gravado. */
async function livePrevRows(storageConn: StorageConnection, schema: string, table: string, fallback: number): Promise<number> {
  try {
    const res = await storageConn.query<{ n: number | bigint }>(`SELECT COUNT(*) AS n FROM ${storageConn.q(schema)}.${storageConn.q(table)} WHERE ${storageConn.q("cw_deleted_at")} IS NULL`);
    const n = Number(res[0]?.n);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Le SO as chaves da origem (tabela: `SELECT <chave> FROM <tabela>`; consulta: `keysSql`, exatamente uma coluna)
 * para a tabela auxiliar `keysTable` no storage (coluna com o nome da chave). Nao loga valores de chave. A tabela
 * auxiliar e removida pelo chamador (finally).
 */
async function readSourceKeys(o: {
  source: { sourceKind: string; sourceSchema: string | null; sourceTable: string | null; keysSql: string | null; connection: Parameters<typeof streamPostgresRows>[0] };
  keyCol: SourceColumn; storageConn: StorageConnection; schema: string; keysTable: string; isMssql: boolean; quoteCol: (c: string) => string;
}): Promise<{ keys: bigint }> {
  const { source, keyCol, storageConn, schema, keysTable, isMssql, quoteCol } = o;
  let keysQuery: string;
  if (source.sourceKind === "table") {
    keysQuery = `SELECT ${quoteCol(keyCol.originalName)} FROM ${isMssql ? quotedMssqlTable(source.sourceSchema!, source.sourceTable!) : quotedPgTable(source.sourceSchema!, source.sourceTable!)}`;
  } else {
    if (!source.keysSql?.trim()) throw new ApiError(400, "KEYS_SQL_REQUIRED", "Fonte sem consulta de chaves configurada");
    keysQuery = source.keysSql;
  }
  // A tabela de chaves usa o nome de coluna do STORAGE (saneado), o mesmo da tabela de destino.
  const keyDef = [{ name: keyCol.sqlName, sqlType: keyCol.sqlType, nullable: true }];
  await storageConn.dropTableIfExists(schema, keysTable);
  await storageConn.createTable(schema, keysTable, keyDef);
  let keys = 0n;
  for await (const rows of (isMssql ? streamMssqlRows(source.connection, keysQuery, 5000) : streamPostgresRows(source.connection, keysQuery, 5000))) {
    const batch: (string | null)[][] = [];
    for (const row of rows) {
      const values = Object.values(row);
      if (values.length !== 1) throw new ApiError(400, "KEYS_SQL_INVALID", "A consulta de chaves deve retornar exatamente uma coluna");
      const v = convertSourceValue(values[0], keyCol.sqlType, { column: keyCol.sqlName });
      if (v != null) batch.push([v]);
    }
    await storageConn.bulkInsert(schema, keysTable, keyDef, batch);
    keys += BigInt(batch.length);
  }
  // Tabela recem-carregada em massa nunca foi analisada: sem estatisticas o planner pode errar o tamanho e
  // escolher um plano ruim para o join da contagem/merge. Best-effort — nao vale falhar a leitura por isso.
  await storageConn.analyzeTable?.(schema, keysTable).catch(() => undefined);
  return { keys };
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
