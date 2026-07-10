import type { NextRequest } from "next/server";
import { resolveActor } from "@/server/auth/actor";
import { syncActorGrants } from "@/server/auth/sync-grants";
import { executeReadOnly } from "@/server/azure/sql";
import { withPg, quotedPgTable, type PgConnection } from "@/server/connections/postgres";
import { ApiError, handleApiError } from "@/server/http";
import { prisma } from "@/server/db";
import { hashToken } from "@/server/security/crypto";
import { env } from "@/server/env";
import type { Actor } from "@/server/auth/actor";

// ── Caches em memória ─────────────────────────────────────────────────────────

const DATASET_CACHE_TTL = 60_000;
const TOKEN_CACHE_TTL   = 60_000;

type CachedDataset = { dataset: Dataset; expiresAt: number };
type CachedToken   = { actor: Actor; expiresAt: number };

const datasetCache = new Map<string, CachedDataset>();
const tokenCache   = new Map<string, CachedToken>();

// ── Auth ──────────────────────────────────────────────────────────────────────

async function resolveODataActor(request: NextRequest): Promise<Actor> {
  const auth = request.headers.get("authorization");

  // 1. Bearer token
  if (auth?.match(/^Bearer\s+/i)) return resolveActor(request);

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
  const now = Date.now();

  const cached = tokenCache.get(hash);
  if (cached && now < cached.expiresAt) return cached.actor;

  const token = await prisma.apiToken.findUnique({ where: { tokenHash: hash } });
  if (!token?.active || (token.expiresAt && token.expiresAt <= new Date())) {
    throw new ApiError(401, "INVALID_TOKEN", "Token inválido, expirado ou revogado.");
  }

  const actor: Actor = { type: "token", id: token.id, role: "TOKEN", principal: `cw_t_${token.id.replaceAll("-", "").slice(0, 24)}` };
  tokenCache.set(hash, { actor, expiresAt: now + TOKEN_CACHE_TTL });

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
type LiveSource = { mode: "live"; connection: PgConnection; sourceKind: string; sourceSchema: string | null; sourceTable: string | null; sourceSql: string | null };
type Table     = { sqlName: string; columns: Column[]; live: LiveSource | null };
type Dataset   = { schemaName: string; tables: Table[] };

async function loadDataset(projectSlug: string, datasetSlug: string): Promise<Dataset> {
  const cacheKey = `${projectSlug}/${datasetSlug}`;
  const now = Date.now();
  const cached = datasetCache.get(cacheKey);
  if (cached && now < cached.expiresAt) return cached.dataset;

  const project = await prisma.project.findFirst({ where: { slug: projectSlug, active: true } });
  if (!project) throw new ApiError(404, "NOT_FOUND", "Projeto não encontrado");

  const dataset = await prisma.dataset.findFirst({
    where: { projectId: project.id, slug: datasetSlug, active: true },
    include: {
      tables: {
        include: {
          columns: { orderBy: { ordinal: "asc" } },
          source: { include: { connection: true } },
        },
      },
    },
  });
  if (!dataset) throw new ApiError(404, "NOT_FOUND", "Dataset não encontrado");

  const tables: Table[] = dataset.tables.map((t) => {
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
          },
          sourceKind: s.sourceKind,
          sourceSchema: s.sourceSchema,
          sourceTable: s.sourceTable,
          sourceSql: s.sourceSql,
        }
      : null;
    return { sqlName: t.sqlName, columns: t.columns, live };
  });

  const result: Dataset = { schemaName: dataset.schemaName, tables };
  datasetCache.set(cacheKey, { dataset: result, expiresAt: now + DATASET_CACHE_TTL });
  return result;
}

// ── Normalização de tipos ─────────────────────────────────────────────────────

function normalizeRow(row: Record<string, unknown>, typeMap: Map<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined) { out[k] = null; continue; }
    const t = typeMap.get(k) ?? "NVARCHAR";
    if (["DATETIME2", "DATETIME", "SMALLDATETIME", "DATETIMEOFFSET"].includes(t)) {
      out[k] = v instanceof Date ? v.toISOString() : v;
    } else if (t === "DATE") {
      out[k] = v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
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

// ── Query live ────────────────────────────────────────────────────────────────

async function queryLiveTable(
  live: LiveSource,
  cols: Column[],
  top: number,
  skip: number,
  needCount: boolean,
): Promise<{ rows: Record<string, unknown>[]; totalCount: number | null }> {
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
    // COUNT e dados em paralelo — duas conexões simultâneas
    const [countResult, dataResult] = await Promise.all([
      withPg(live.connection, (client) =>
        client.query<{ cnt: string }>(`SELECT COUNT(*) AS cnt FROM ${baseExpr}`),
      ),
      withPg(live.connection, (client) =>
        client.query<Record<string, unknown>>(`SELECT ${colList} FROM ${baseExpr} LIMIT ${top} OFFSET ${skip}`),
      ),
    ]);
    return {
      rows: dataResult.rows.map((row) => normalizeRow(row, typeMap)),
      totalCount: Number(countResult.rows[0]?.cnt ?? 0),
    };
  }

  return withPg(live.connection, async (client) => {
    const dataResult = await client.query<Record<string, unknown>>(
      `SELECT ${colList} FROM ${baseExpr} LIMIT ${top} OFFSET ${skip}`,
    );
    return { rows: dataResult.rows.map((row) => normalizeRow(row, typeMap)), totalCount: null };
  });
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
        .map((c) => `      <Property Name="${escXml(c.sqlName)}" Type="${sqlToEdmType(c.sqlType)}" Nullable="${c.nullable}"/>`)
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
    const rawTop  = parseInt(url.searchParams.get("$top")  ?? "1000", 10);
    const rawSkip = parseInt(url.searchParams.get("$skip") ?? "0", 10);
    const selectParam = url.searchParams.get("$select");
    const countParam  = url.searchParams.get("$count");

    const top  = Math.min(Math.max(1, isNaN(rawTop)  ? 1000 : rawTop),  10_000);
    const skip = Math.max(0, isNaN(rawSkip) ? 0 : rawSkip);

    const cols = selectParam
      ? table.columns.filter((c) => selectParam.split(",").map((s) => s.trim()).includes(c.sqlName))
      : table.columns;
    if (cols.length === 0) throw new ApiError(400, "BAD_REQUEST", "Nenhuma coluna válida selecionada");

    const needCount = countParam === "true";
    const response: Record<string, unknown> = { "@odata.context": `${baseUrl}/$metadata#${table.sqlName}` };

    if (table.live) {
      const { rows, totalCount } = await queryLiveTable(table.live, cols, top, skip, needCount);
      response["value"] = rows.map((r, i) => ({ ...r, _row_number: String(skip + i + 1) }));
      if (needCount) response["@odata.count"] = String(totalCount ?? 0);
      if (rows.length === top) {
        const next = new URL(`${baseUrl}/${table.sqlName}`);
        next.searchParams.set("$top", String(top));
        next.searchParams.set("$skip", String(skip + top));
        if (selectParam) next.searchParams.set("$select", selectParam);
        if (needCount) next.searchParams.set("$count", "true");
        response["@odata.nextLink"] = appendApiKey(next, apiKey);
      }
    } else {
      await syncActorGrants(actor);
      const colList = cols.map((c) => `[${c.sqlName}]`).join(", ");
      const dataSql  = `SELECT ${colList}, ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS [_row_number] FROM [${dataset.schemaName}].[${table.sqlName}] ORDER BY (SELECT NULL) OFFSET ${skip} ROWS FETCH NEXT ${top} ROWS ONLY`;
      const countSql = `SELECT COUNT(*) AS [cnt] FROM [${dataset.schemaName}].[${table.sqlName}]`;

      // COUNT e dados em paralelo quando solicitado
      const [result, countResult] = await Promise.all([
        executeReadOnly(actor.principal, dataSql, 120, top, [dataset.schemaName]),
        needCount ? executeReadOnly(actor.principal, countSql, 30, 1, [dataset.schemaName]) : Promise.resolve(null),
      ]);

      const typeMap = new Map(cols.map((c) => [c.sqlName, c.sqlType.toUpperCase().replace(/\(.*\)/, "").trim()]));
      response["value"] = result.rows.map((row) => normalizeRow(row as Record<string, unknown>, typeMap));
      if (needCount) response["@odata.count"] = String((countResult!.rows[0] as Record<string, unknown>)?.cnt ?? 0);
      if (result.rows.length === top) {
        const next = new URL(`${baseUrl}/${table.sqlName}`);
        next.searchParams.set("$top", String(top));
        next.searchParams.set("$skip", String(skip + top));
        if (selectParam) next.searchParams.set("$select", selectParam);
        if (needCount) next.searchParams.set("$count", "true");
        response["@odata.nextLink"] = appendApiKey(next, apiKey);
      }
    }

    return Response.json(response, { headers: ODATA_HEADERS });
  } catch (e) {
    if (process.env.NODE_ENV !== "production" && !(e instanceof ApiError)) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ debug: msg }, { status: 500 });
    }
    return handleApiError(e);
  }
}
