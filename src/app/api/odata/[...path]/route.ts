import type { NextRequest } from "next/server";
import { resolveActor } from "@/server/auth/actor";
import { syncActorGrants } from "@/server/auth/sync-grants";
import { executeReadOnly } from "@/server/azure/sql";
import { withPg, quotedPgTable } from "@/server/connections/postgres";
import { executeLiveReadOnly, isMssqlConnection, liveCount, liveQuoteIdent, liveQuotedTable, type LiveConnection } from "@/server/connections/live";
import { assertDatasetAccess } from "@/server/auth/permissions";
import { ODataOptionError, planODataQuery, type ODataQueryPlan } from "@/server/odata/query-options";
import { edmFacets, MAX_PAGE, nextPageParams as nextParams, parseNonNegativeInt, parseSelect } from "@/server/odata/paging-facets";
import { PG_STRING_TYPES } from "@/server/storage/pg-types";
import { pgDateText, pgTimestampToIso } from "@/server/sql-contract/result";
import { stableOrderBy, UNSTABLE_ORDER_WARNING } from "@/server/odata/stable-order";
import { getStorageConnection } from "@/server/storage/connection";
import { activeRowsPredicate, joinWhere } from "@/server/storage/active-rows";
import type { PgStorageConnection } from "@/server/storage/pg-storage";
import { ApiError, handleApiError } from "@/server/http";
import { prisma } from "@/server/db";
import { hashToken } from "@/server/security/crypto";
import { env } from "@/server/env";
import type { Actor } from "@/server/auth/actor";
import { TtlCache } from "@/server/cache/ttl-cache";
import { getPageCache, setPageCache } from "@/server/cache/odata-page-cache";

// ── Caches em memória ─────────────────────────────────────────────────────────
// Todos os caches abaixo usam TtlCache: TTL + limite de tamanho + varredura
// periódica ativa, para não crescerem sem limite num processo de vida longa
// (já causou OOM em produção quando eram Map cru sem eviction — ver
// git blame / incidente de heap exhaustion no serviço web).

const DATASET_CACHE_TTL = 60_000;
const TOKEN_CACHE_TTL   = 15_000; // revogar token vale em ate 15s
const COUNT_CACHE_TTL   = 300_000; // 5 min — count não muda entre páginas de um mesmo refresh
const DEFAULT_TOP       = 5_000;   // Power BI pagina em blocos — 5k reduz de ~52 req para ~11

const datasetCache = new TtlCache<string, Dataset>(DATASET_CACHE_TTL, 500);
const tokenCache   = new TtlCache<string, Actor>(TOKEN_CACHE_TTL, 500);
const countCache   = new TtlCache<string, number>(COUNT_CACHE_TTL, 2_000);

// ── Semáforo OData ────────────────────────────────────────────────────────────
// Limita consultas DB simultâneas (MSSQL + PG) para não saturar o pool de leitura.
const ODATA_MAX_CONCURRENT = 3;
let _odataConcurrent = 0;
const _odataQueue: Array<() => void> = [];

async function withODataSemaphore<T>(fn: () => Promise<T>): Promise<T> {
  if (_odataConcurrent < ODATA_MAX_CONCURRENT) {
    _odataConcurrent++;
  } else {
    await new Promise<void>((resolve) => _odataQueue.push(resolve));
  }
  try {
    return await fn();
  } finally {
    const next = _odataQueue.shift();
    if (next) { next(); } else { _odataConcurrent--; }
  }
}

// ── Cache de páginas OData ────────────────────────────────────────────────────
// getPageCache/setPageCache/invalidateODataPageCache moraram aqui antes; foram
// movidos pra @/server/cache/odata-page-cache porque route.ts do App Router só
// pode exportar handlers HTTP — o export de invalidateODataPageCache quebrava
// o typecheck do Next ("does not satisfy the constraint '{ [x: string]: never; }'").

// ── Auth ──────────────────────────────────────────────────────────────────────

async function resolveODataActor(request: NextRequest): Promise<Actor> {
  const auth = request.headers.get("authorization");

  // 1. Bearer token
  if (auth?.match(/^Bearer\s+/i)) return resolveActor(request, { rateLimit: false });

  // 2. Basic auth
  const basic = auth?.match(/^Basic\s+(.+)$/i)?.[1];
  const rawToken = basic
    ? (() => { const d = Buffer.from(basic, "base64").toString("utf-8"); const i = d.indexOf(":"); return i >= 0 ? d.slice(i + 1) : d; })()
    : request.nextUrl.searchParams.get("api_key");

  if (rawToken) return resolveApiToken(rawToken);

  throw new ApiError(401, "UNAUTHENTICATED", "Autenticação necessária. Use Basic auth ou Authorization: Bearer <token>.");
}

async function resolveApiToken(raw: string): Promise<Actor> {
  const hash = hashToken(raw);

  const cached = tokenCache.get(hash);
  if (cached) return cached;

  const token = await prisma.apiToken.findUnique({ where: { tokenHash: hash } });
  if (!token?.active || (token.expiresAt && token.expiresAt <= new Date())) {
    throw new ApiError(401, "INVALID_TOKEN", "Token inválido, expirado ou revogado.");
  }

  const actor: Actor = { type: "token", id: token.id, role: "TOKEN", principal: `cw_t_${token.id.replaceAll("-", "").slice(0, 24)}` };
  tokenCache.set(hash, actor);

  // lastUsedAt fire-and-forget — não bloqueia a request
  prisma.apiToken.update({ where: { id: token.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);

  return actor;
}

// ── Dataset metadata (com cache) ──────────────────────────────────────────────

function publicOrigin(): string {
  return env().CATWORLD_PUBLIC_ORIGIN ?? "";
}

function appendApiKey(url: URL, apiKey: string | null): string {
  if (apiKey) url.searchParams.set("api_key", apiKey);
  return url.toString();
}

function sqlToEdmType(sqlType: string): string {
  const t = sqlType.toUpperCase().replace(/\(.*\)/, "").trim();
  if (["NVARCHAR", "VARCHAR", "CHAR", "NCHAR", "TEXT", "NTEXT"].includes(t)) return "Edm.String";
  if (t === "BIGINT") return "Edm.Int64";
  if (["INT", "INTEGER", "SMALLINT", "TINYINT"].includes(t)) return "Edm.Int32";
  if (t === "BIT") return "Edm.Boolean";
  if (["DECIMAL", "NUMERIC", "MONEY", "SMALLMONEY"].includes(t)) return "Edm.Decimal";
  if (["FLOAT", "REAL"].includes(t)) return "Edm.Double";
  if (["DATETIME", "DATETIME2", "SMALLDATETIME", "DATETIMEOFFSET"].includes(t)) return "Edm.DateTimeOffset";
  if (t === "DATE") return "Edm.Date";
  if (t === "TIME") return "Edm.TimeOfDay";
  if (t === "UNIQUEIDENTIFIER") return "Edm.Guid";
  return "Edm.String";
}

function escXml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

type Column    = { originalName: string; sqlName: string; sqlType: string; nullable: boolean };
type LiveSource = { mode: "live"; connection: LiveConnection; sourceKind: string; sourceSchema: string | null; sourceTable: string | null; sourceSql: string | null };
type Table     = { sqlName: string; columns: Column[]; live: LiveSource | null };
type Dataset   = { id: string; projectId: string; schemaName: string; storageServerId: string | null; tables: Table[] };

async function loadDataset(projectSlug: string, datasetSlug: string): Promise<Dataset> {
  const cacheKey = `${projectSlug}/${datasetSlug}`;
  const cached = datasetCache.get(cacheKey);
  if (cached) return cached;

  const project = await prisma.project.findFirst({ where: { slug: projectSlug, active: true } });
  if (!project) throw new ApiError(404, "NOT_FOUND", "Projeto não encontrado");

  const dataset = await prisma.dataset.findFirst({
    where: { projectId: project.id, slug: datasetSlug, active: true },
    include: {
      // storageServerId é campo direto no Dataset — incluído automaticamente pelo Prisma
      tables: {
        include: {
          columns: { orderBy: { ordinal: "asc" } },
          source: { include: { connection: true } },
        },
      },
    },
  });
  if (!dataset) throw new ApiError(404, "NOT_FOUND", "Dataset não encontrado");

  const tables: Table[] = dataset.tables.map((t: (typeof dataset.tables)[number]) => {
    const s = t.source;
    const live: LiveSource | null = s?.mode === "live"
      ? {
          mode: "live",
          connection: {
            server: s.connection.server,
            port: s.connection.port,
            databaseName: s.connection.databaseName,
            username: s.connection.username,
            encryptedCredentials: s.connection.encryptedCredentials,
            sslMode: s.connection.sslMode,
            provider: s.connection.provider,
            sshTunnelEnabled: s.connection.sshTunnelEnabled,
            sshHost: s.connection.sshHost,
            sshPort: s.connection.sshPort,
            sshUsername: s.connection.sshUsername,
            sshAuthMethod: s.connection.sshAuthMethod,
            sshEncryptedSecret: s.connection.sshEncryptedSecret,
          },
          sourceKind: s.sourceKind,
          sourceSchema: s.sourceSchema,
          sourceTable: s.sourceTable,
          sourceSql: s.sourceSql,
        }
      : null;
    return { sqlName: t.sqlName, columns: t.columns, live };
  });

  const result: Dataset = { id: dataset.id, projectId: dataset.projectId, schemaName: dataset.schemaName, storageServerId: dataset.storageServerId, tables };
  datasetCache.set(cacheKey, result);
  return result;
}

// ── Normalização de tipos ─────────────────────────────────────────────────────

function normalizeRow(row: Record<string, unknown>, typeMap: Map<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined) { out[k] = null; continue; }
    const t = typeMap.get(k) ?? "NVARCHAR";
    if (["DATETIME2", "DATETIME", "SMALLDATETIME", "DATETIMEOFFSET"].includes(t)) {
      // pg entrega TEXTO (PG_STRING_TYPES): independente do fuso do Node, com microssegundos e 'infinity'; sem fuso = UTC
      out[k] = v instanceof Date ? (Number.isNaN(v.getTime()) ? null : v.toISOString()) : typeof v === "string" ? pgTimestampToIso(v) : v;
    } else if (t === "DATE") {
      out[k] = v instanceof Date ? v.toISOString().slice(0, 10) : pgDateText(String(v));
    } else if (t === "TIME") {
      out[k] = String(v);
    } else if (["FLOAT", "REAL"].includes(t)) {
      if (typeof v === "number" && isNaN(v)) out[k] = "NaN";
      else if (typeof v === "number" && !isFinite(v)) out[k] = v > 0 ? "INF" : "-INF";
      else out[k] = v;
    } else if (["BIGINT", "DECIMAL", "NUMERIC"].includes(t)) {
      out[k] = typeof v === "number" ? String(v) : v;
    } else {
      if (typeof v === "boolean") out[k] = String(v);
      else if (typeof v === "object" && !(v instanceof Date)) out[k] = JSON.stringify(v);
      else out[k] = v;
    }
  }
  return out;
}

// ── Cache de COUNT ────────────────────────────────────────────────────────────

// Fonte live nao tem "versao dos dados" (dataVersion = "live"): um COUNT em cache por 5 min serviria contagem velha
// junto de paginas novas. So storage (com a versao dos dados na chave) usa o cache.
const cacheable = (key: string) => !key.includes("/live/");

function getCachedCount(key: string): number | null {
  return cacheable(key) ? countCache.get(key) : null;
}

function setCachedCount(key: string, count: number) {
  if (cacheable(key)) countCache.set(key, count);
}

// ── Query live ────────────────────────────────────────────────────────────────

async function queryLiveTable(
  live: LiveSource,
  cols: Column[],
  top: number,
  skip: number,
  needCount: boolean,
  countCacheKey: string,
  plan: ODataQueryPlan,
): Promise<{ rows: Record<string, unknown>[]; totalCount: number | null }> {
  if (isMssqlConnection(live.connection)) return queryLiveMssql(live, cols, top, skip, needCount, countCacheKey, plan);
  const whereSql = plan.where ? ` WHERE ${plan.where}` : "";
  // Sem $orderby, OFFSET nao e deterministico: tabela => ctid; consulta => todas as colunas ordenaveis. $orderby recebe desempate.
  const tieBreak = live.sourceKind === "table"
    ? "ctid"
    : stableOrderBy(cols.map((c) => ({ name: c.originalName, sqlType: c.sqlType })), (n) => `"${n.replaceAll('"', '""')}"`);
  if (!tieBreak && !plan.orderBy) plan.warnings.push(UNSTABLE_ORDER_WARNING);
  const orderList = [plan.orderBy, tieBreak].filter(Boolean).join(", ");
  const orderSql = orderList ? ` ORDER BY ${orderList}` : "";
  const colList = cols.map((c) => {
    const orig  = `"${c.originalName.replaceAll('"', '""')}"`;
    const alias = `"${c.sqlName.replaceAll('"', '""')}"`;
    return orig === alias ? orig : `${orig} AS ${alias}`;
  }).join(", ");

  const baseExpr = live.sourceKind === "table"
    ? quotedPgTable(live.sourceSchema!, live.sourceTable!)
    : `(${live.sourceSql!.replace(/;\s*$/, "")}) cw_live_src`;

  const typeMap = new Map(cols.map((c) => [c.sqlName, c.sqlType.toUpperCase().replace(/\(.*\)/, "").trim()]));

  if (needCount) {
    const cachedCount = getCachedCount(countCacheKey);
    if (cachedCount !== null) {
      return withPg(live.connection, async (client) => {
        const dataResult = await client.query<Record<string, unknown>>({
          text: `SELECT ${colList} FROM ${baseExpr}${whereSql}${orderSql} LIMIT ${top} OFFSET ${skip}`,
          types: PG_STRING_TYPES,
        } as never);
        return { rows: dataResult.rows.map((row) => normalizeRow(row, typeMap)), totalCount: cachedCount };
      });
    }
    // COUNT e dados em paralelo — duas conexões simultâneas
    const [countResult, dataResult] = await Promise.all([
      withPg(live.connection, (client) =>
        client.query<{ cnt: string }>(`SELECT COUNT(*) AS cnt FROM ${baseExpr}${whereSql}`),
      ),
      withPg(live.connection, (client) =>
        client.query<Record<string, unknown>>({ text: `SELECT ${colList} FROM ${baseExpr}${whereSql}${orderSql} LIMIT ${top} OFFSET ${skip}`, types: PG_STRING_TYPES } as never),
      ),
    ]);
    const totalCount = Number(countResult.rows[0]?.cnt ?? 0);
    setCachedCount(countCacheKey, totalCount);
    return {
      rows: dataResult.rows.map((row) => normalizeRow(row, typeMap)),
      totalCount,
    };
  }

  return withPg(live.connection, async (client) => {
    const dataResult = await client.query<Record<string, unknown>>({
      text: `SELECT ${colList} FROM ${baseExpr}${whereSql}${orderSql} LIMIT ${top} OFFSET ${skip}`,
      types: PG_STRING_TYPES,
    } as never);
    return { rows: dataResult.rows.map((row) => normalizeRow(row, typeMap)), totalCount: null };
  });
}

/** Fonte live MSSQL: mesma resposta do caminho Postgres, paginacao pelo executor MSSQL. */
async function queryLiveMssql(
  live: LiveSource,
  cols: Column[],
  top: number,
  skip: number,
  needCount: boolean,
  countCacheKey: string,
  plan: ODataQueryPlan,
): Promise<{ rows: Record<string, unknown>[]; totalCount: number | null }> {
  const q = (n: string) => liveQuoteIdent(live.connection, n);
  const colList = cols.map((c) => (c.originalName === c.sqlName ? q(c.originalName) : `${q(c.originalName)} AS ${q(c.sqlName)}`)).join(", ");
  const baseExpr = live.sourceKind === "table"
    ? liveQuotedTable(live.connection, live.sourceSchema!, live.sourceTable!)
    : `(${live.sourceSql!.replace(/;\s*$/, "")}) cw_live_src`;
  const typeMap = new Map(cols.map((c) => [c.sqlName, c.sqlType.toUpperCase().replace(/\(.*\)/, "").trim()]));

  let totalCount: number | null = null;
  if (needCount) {
    totalCount = getCachedCount(countCacheKey);
    if (totalCount === null) {
      totalCount = await liveCount(live.connection, baseExpr);
      setCachedCount(countCacheKey, totalCount);
    }
  }
  // A ordem vale sobre os ALIAS da SELECT final (o executor embrulha a consulta e pagina por fora).
  const order = stableOrderBy(cols.map((c) => ({ name: c.sqlName, sqlType: c.sqlType })), q);
  if (!order) plan.warnings.push(UNSTABLE_ORDER_WARNING);
  if (top === 0) return { rows: [], totalCount };
  const data = await executeLiveReadOnly(live.connection, `SELECT ${colList} FROM ${baseExpr}`, 60, top, skip, false, order ?? undefined);
  return { rows: data.rows.map((row) => normalizeRow(row as Record<string, unknown>, typeMap)), totalCount };
}

// ── Metadata OData ────────────────────────────────────────────────────────────

function buildServiceDocument(baseUrl: string, dataset: Dataset) {
  return {
    "@odata.context": `${baseUrl}/$metadata`,
    value: dataset.tables.map((t) => ({ name: t.sqlName, kind: "EntitySet", url: t.sqlName })),
  };
}

function buildMetadata(dataset: Dataset): string {
  const ns = "catworld";
  const entityTypes = dataset.tables
    .map((t) => {
      const props = t.columns
        .map((c) => `      <Property Name="${escXml(c.sqlName)}" Type="${sqlToEdmType(c.sqlType)}" Nullable="${c.nullable}"${edmFacets(c.sqlType)}/>`)
        .join("\n");
      return `    <EntityType Name="${escXml(t.sqlName)}">
      <Key><PropertyRef Name="_row_number"/></Key>
      <Property Name="_row_number" Type="Edm.Int64" Nullable="false"/>
${props}
    </EntityType>`;
    })
    .join("\n");

  const entitySets = dataset.tables
    .map((t) => `      <EntitySet Name="${escXml(t.sqlName)}" EntityType="${ns}.${escXml(t.sqlName)}"/>`)
    .join("\n");

  return `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="${ns}" xmlns="http://docs.oasis-open.org/odata/ns/edm">
${entityTypes}
      <EntityContainer Name="Container">
${entitySets}
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;
}

const ODATA_HEADERS = { "OData-Version": "4.0", "content-type": "application/json;odata.metadata=minimal;IEEE754Compatible=true" };

// ── Handler ───────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  try {
    const [actor, resolvedPath] = await Promise.all([
      resolveODataActor(request),
      params.then((p) => p.path ?? []),
    ]);

    if (resolvedPath.length < 2) throw new ApiError(400, "BAD_REQUEST", "URL inválida. Use /api/odata/{projeto}/{dataset}");

    const [projectSlug, datasetSlug, ...rest] = resolvedPath;
    const dataset = await loadDataset(projectSlug!, datasetSlug!);
    // Antes nao havia checagem: um token com grant so no dataset A lia o dataset B (e listava suas tabelas) pela URL.
    await assertDatasetAccess(actor, "READ", { id: dataset.id, projectId: dataset.projectId });

    const origin = publicOrigin();
    const baseUrl = `${origin}/api/odata/${projectSlug}/${datasetSlug}`;
    const apiKey = request.nextUrl.searchParams.get("api_key");

    if (rest.length === 0) {
      return Response.json(buildServiceDocument(baseUrl, dataset), { headers: ODATA_HEADERS });
    }

    if (rest[0] === "$metadata") {
      return new Response(buildMetadata(dataset), {
        headers: { "content-type": "application/xml; charset=utf-8", "OData-Version": "4.0" },
      });
    }

    const tableSqlName = rest[0]!;
    const table = dataset.tables.find((t) => t.sqlName === tableSqlName);
    if (!table) throw new ApiError(404, "NOT_FOUND", "Tabela não encontrada");

    const url = request.nextUrl;
    // $top/$skip: inteiro >= 0 (OData v4). Antes "abc" virava 1000 e negativo virava 0/1 sem aviso.
    const intParam = (name: string, dflt: number): number => {
      try { return parseNonNegativeInt(url.searchParams.get(name), name, dflt); }
      catch (e) { throw new ApiError(400, "ODATA_INVALID_QUERY", e instanceof Error ? e.message : `${name} invalido`); }
    };
    const topRequested = url.searchParams.has("$top");
    const wantedTop = intParam("$top", DEFAULT_TOP);
    const selectParam = url.searchParams.get("$select");
    const countParam  = url.searchParams.get("$count");
    const topWarnings: string[] = [];
    // $top=0 e valido (so contagem/metadados). O teto por pagina e 10000: acima disso o servidor pagina (nextLink) e
    // o total pedido em $top e respeitado nas paginas seguintes (o nextLink carrega o $top RESTANTE).
    const top  = Math.min(wantedTop, MAX_PAGE);
    if (top !== wantedTop) topWarnings.push(`$top=${wantedTop} excede 10000 por pagina: siga @odata.nextLink (o total pedido sera respeitado)`);
    const skip = intParam("$skip", 0);
    const nextPageParams = (returned: number) => nextParams({ top, wantedTop, topRequested, skip, returned });

    const wantedCols = parseSelect(selectParam);
    const unknownCols = wantedCols ? wantedCols.filter((n) => !table.columns.some((c) => c.sqlName === n)) : [];
    if (unknownCols.length) throw new ApiError(400, "ODATA_INVALID_QUERY", `$select referencia coluna(s) inexistente(s): ${unknownCols.join(", ")}`);
    const cols = wantedCols ? table.columns.filter((c) => wantedCols.includes(c.sqlName)) : table.columns;
    if (cols.length === 0) throw new ApiError(400, "BAD_REQUEST", "Nenhuma coluna válida selecionada");

    const needCount = countParam === "true";
    // $filter/$orderby (subconjunto): aplicados no Postgres; o que nao for entendido segue ignorado (como sempre foi) COM aviso.
    const filterParam = url.searchParams.get("$filter");
    const orderbyParam = url.searchParams.get("$orderby");
    const provider = table.live
      ? (isMssqlConnection(table.live.connection) ? "mssql" : "postgres")
      : (await getStorageConnection(dataset.storageServerId)).provider;
    const liveOrig = new Map(table.columns.map((c) => [c.sqlName, c.originalName]));
    const refCol = (c: { sqlName: string }) => `"${(table.live ? (liveOrig.get(c.sqlName) ?? c.sqlName) : c.sqlName).replaceAll('"', '""')}"`;
    let plan: ODataQueryPlan;
    try {
      plan = planODataQuery(url.searchParams, table.columns, refCol, provider === "postgres");
    } catch (e) {
      if (e instanceof ODataOptionError) throw new ApiError(e.status, e.code, e.message);
      throw e;
    }
    plan.warnings.push(...topWarnings);
    // Versao dos dados (storage): upload/sync gravam last_data_at; entra nas chaves de cache para contagem/pagina nao servirem dado velho.
    let dataVersion = "live";
    if (!table.live) {
      const agg = await prisma.datasetTable.aggregate({
        where: { datasetId: dataset.id, sqlName: table.sqlName },
        _max: { lastDataAt: true, updatedAt: true },
        _count: { _all: true },
      });
      dataVersion = `${agg._count._all}:${agg._max.lastDataAt?.getTime() ?? 0}:${agg._max.updatedAt?.getTime() ?? 0}`;
    }
    const countCacheKey = `${projectSlug}/${datasetSlug}/${table.sqlName}/${dataVersion}/${plan.where ?? ""}`;
    const response: Record<string, unknown> = { "@odata.context": `${baseUrl}/$metadata#${table.sqlName}` };

    if (table.live) {
      const { rows, totalCount } = await withODataSemaphore(() =>
        queryLiveTable(table.live!, cols, top, skip, needCount, countCacheKey, plan),
      );
      response["value"] = rows.map((r, i) => ({ ...r, _row_number: String(skip + i + 1) }));
      if (needCount) response["@odata.count"] = String(totalCount ?? 0);
      const np = nextPageParams(rows.length);
      if (np) {
        const next = new URL(`${baseUrl}/${table.sqlName}`);
        if (np.top !== null) next.searchParams.set("$top", np.top);
        next.searchParams.set("$skip", np.skip);
        if (selectParam) next.searchParams.set("$select", selectParam);
        if (needCount) next.searchParams.set("$count", "true");
        if (filterParam) next.searchParams.set("$filter", filterParam);
        if (orderbyParam) next.searchParams.set("$orderby", orderbyParam);
        response["@odata.nextLink"] = appendApiKey(next, apiKey);
      }
    } else {
      await syncActorGrants(actor, { datasetIds: [dataset.id] });

      // Cache de página: evita hits ao banco para queries idênticas repetitivas (Power BI, SDK)
      const pageCacheKey = `${projectSlug}/${datasetSlug}/${table.sqlName}/${dataVersion}/${top}/${skip}/${selectParam ?? ""}/${needCount}/${filterParam ?? ""}/${orderbyParam ?? ""}`;
      const cachedPage = getPageCache(pageCacheKey);
      if (cachedPage) {
        Object.assign(response, cachedPage);
      } else {
        const typeMap = new Map(cols.map((c) => [c.sqlName, c.sqlType.toUpperCase().replace(/\(.*\)/, "").trim()]));
        let dataRowsLength = 0;
        const setNextLink = () => {
          const np = nextPageParams(dataRowsLength);
          if (np) {
            const next = new URL(`${baseUrl}/${table.sqlName}`);
            if (np.top !== null) next.searchParams.set("$top", np.top);
            next.searchParams.set("$skip", np.skip);
            if (selectParam) next.searchParams.set("$select", selectParam);
            if (needCount) next.searchParams.set("$count", "true");
        if (filterParam) next.searchParams.set("$filter", filterParam);
        if (orderbyParam) next.searchParams.set("$orderby", orderbyParam);
            response["@odata.nextLink"] = appendApiKey(next, apiKey);
          }
        };
        const cacheBuilt = () => {
          const pageCachePayload: Record<string, unknown> = {};
          if (response["value"] !== undefined) pageCachePayload["value"] = response["value"];
          if (response["@odata.count"] !== undefined) pageCachePayload["@odata.count"] = response["@odata.count"];
          if (response["@odata.nextLink"] !== undefined) pageCachePayload["@odata.nextLink"] = response["@odata.nextLink"];
          setPageCache(pageCacheKey, pageCachePayload);
        };

        const q = (n: string) => `"${n.replaceAll('"', '""')}"`;
        const conn = await getStorageConnection(dataset.storageServerId);

        // ── Storage PostgreSQL ──────────────────────────────────────────────
        if (conn.provider === "postgres") {
          const pgConn = conn as PgStorageConnection;
          const colList = cols.map((c) => q(c.sqlName)).join(", ");
          const fromExpr = `${q(dataset.schemaName)}.${q(table.sqlName)}`;
          // Esconde linhas excluídas na origem (cw_deleted_at); o $filter do cliente vem junto por AND.
          const whereSql = joinWhere(plan.where, await activeRowsPredicate(pgConn, dataset.schemaName, table.sqlName));
          // ctid desempata (e ordena quando nao ha $orderby): sem isso OFFSET pode repetir/pular linhas entre paginas.
          const orderSql = ` ORDER BY ${[plan.orderBy, "ctid"].filter(Boolean).join(", ")}`;
          const dataSql = `SELECT ${colList} FROM ${fromExpr}${whereSql}${orderSql} OFFSET ${skip} LIMIT ${top}`;
          const countSql = `SELECT COUNT(*) AS cnt FROM ${fromExpr}${whereSql}`;

          const cachedCount = getCachedCount(countCacheKey);
          const [dataRows, countResult] = await withODataSemaphore(() => Promise.all([
            pgConn._pool.query<Record<string, unknown>>({ text: dataSql, types: PG_STRING_TYPES } as never).then((r) => r.rows),
            needCount && cachedCount === null
              ? pgConn.query<{ cnt: string }>(countSql)
              : Promise.resolve([]),
          ]));

          response["value"] = dataRows.map((row, i) => ({ ...normalizeRow(row, typeMap), _row_number: String(skip + i + 1) }));
          if (needCount) {
            const cnt = cachedCount ?? Number(countResult[0]?.cnt ?? 0);
            setCachedCount(countCacheKey, cnt);
            response["@odata.count"] = String(cnt);
          }
          dataRowsLength = dataRows.length;
          setNextLink();
          cacheBuilt();

        // ── Storage MSSQL ───────────────────────────────────────────────────
        } else {
          const colList = cols.map((c) => `[${c.sqlName}]`).join(", ");
          // Sem OFFSET/FETCH aqui: o executor pagina (offset/limit) e acrescenta o proprio OFFSET ao ORDER BY final. _row_number = skip + posicao.
          const order = stableOrderBy(cols.map((c) => ({ name: c.sqlName, sqlType: c.sqlType })), (n) => `[${n.replaceAll("]", "]]")}]`);
          if (!order) plan.warnings.push(UNSTABLE_ORDER_WARNING);
          const activeWhere = joinWhere(await activeRowsPredicate(conn, dataset.schemaName, table.sqlName));
          const dataSql  = `SELECT ${colList} FROM [${dataset.schemaName}].[${table.sqlName}]${activeWhere} ORDER BY ${order ?? "(SELECT NULL)"}`;
          const countSql = `SELECT COUNT(*) AS [cnt] FROM [${dataset.schemaName}].[${table.sqlName}]${activeWhere}`;

          const cachedCount = getCachedCount(countCacheKey);
          const [result, countResult] = await withODataSemaphore(() => Promise.all([
            executeReadOnly(actor.principal, dataSql, 120, top, [dataset.schemaName], skip, 120, dataset.storageServerId),
            needCount && cachedCount === null
              ? executeReadOnly(actor.principal, countSql, 30, 1, [dataset.schemaName], 0, 120, dataset.storageServerId)
              : Promise.resolve(null),
          ]));

          response["value"] = result.rows.map((row, i) => ({ ...normalizeRow(row as Record<string, unknown>, typeMap), _row_number: String(skip + i + 1) }));
          if (needCount) {
            const cnt = cachedCount ?? Number((countResult!.rows[0] as Record<string, unknown>)?.cnt ?? 0);
            setCachedCount(countCacheKey, cnt);
            response["@odata.count"] = String(cnt);
          }
          dataRowsLength = result.rows.length;
          setNextLink();
          cacheBuilt();
        }
      }
    }

    // Opcoes nao suportadas viram erro 400/501 (planODataQuery); aqui so avisos informativos (ex.: $top acima do teto).
    const headers: Record<string, string> = { ...ODATA_HEADERS };
    if (plan.warnings.length) headers["Warning"] = plan.warnings.map((w) => `299 catworld "${w.replace(/"/g, "'")}"`).join(", ");
    return Response.json(response, { headers });
  } catch (e) {
    if (process.env.NODE_ENV !== "production" && !(e instanceof ApiError)) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ debug: msg }, { status: 500 });
    }
    return handleApiError(e);
  }
}
