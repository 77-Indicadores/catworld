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

async function resolveODataActor(request: NextRequest): Promise<Actor> {
  const auth = request.headers.get("authorization");

  // 1. Bearer token
  if (auth?.match(/^Bearer\s+/i)) return resolveActor(request);

  // 2. Basic auth — Power BI Desktop (usuário: qualquer, senha: token)
  const basic = auth?.match(/^Basic\s+(.+)$/i)?.[1];
  if (basic) {
    const decoded = Buffer.from(basic, "base64").toString("utf-8");
    const colonIdx = decoded.indexOf(":");
    const password = colonIdx >= 0 ? decoded.slice(colonIdx + 1) : decoded;
    if (password) {
      const token = await prisma.apiToken.findUnique({ where: { tokenHash: hashToken(password) } });
      if (token?.active && !(token.expiresAt && token.expiresAt <= new Date())) {
        await prisma.apiToken.update({ where: { id: token.id }, data: { lastUsedAt: new Date() } });
        return { type: "token", id: token.id, role: "TOKEN", principal: `cw_t_${token.id.replaceAll("-", "").slice(0, 24)}` };
      }
      throw new ApiError(401, "INVALID_TOKEN", "Token inválido, expirado ou revogado.");
    }
  }

  // 3. ?api_key=TOKEN — Power BI Service com autenticação Anônima
  const apiKey = request.nextUrl.searchParams.get("api_key");
  if (apiKey) {
    const token = await prisma.apiToken.findUnique({ where: { tokenHash: hashToken(apiKey) } });
    if (token?.active && !(token.expiresAt && token.expiresAt <= new Date())) {
      await prisma.apiToken.update({ where: { id: token.id }, data: { lastUsedAt: new Date() } });
      return { type: "token", id: token.id, role: "TOKEN", principal: `cw_t_${token.id.replaceAll("-", "").slice(0, 24)}` };
    }
    throw new ApiError(401, "INVALID_TOKEN", "Token inválido, expirado ou revogado.");
  }

  throw new ApiError(401, "UNAUTHENTICATED", "Autenticação necessária. Use ?api_key=<token>, Basic auth ou Authorization: Bearer <token>.");
}

function publicOrigin(): string {
  return env().CATWORLD_PUBLIC_ORIGIN ?? "";
}

// Preserva ?api_key nas URLs de paginação para que o Power BI continue autenticado
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

type Column = { originalName: string; sqlName: string; sqlType: string; nullable: boolean };
type LiveSource = { mode: "live"; connection: PgConnection; sourceKind: string; sourceSchema: string | null; sourceTable: string | null; sourceSql: string | null };
type Table = { sqlName: string; columns: Column[]; live: LiveSource | null };
type Dataset = { schemaName: string; tables: Table[] };

async function loadDataset(projectSlug: string, datasetSlug: string): Promise<Dataset> {
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
  return { schemaName: dataset.schemaName, tables };
}

async function queryLiveTable(
  live: LiveSource,
  cols: Column[],
  top: number,
  skip: number,
  needCount: boolean,
): Promise<{ rows: Record<string, unknown>[]; totalCount: number | null }> {
  // Postgres usa originalName; alias para sqlName para manter consistência com tabelas extract
  const colList = cols.map((c) => {
    const orig = `"${c.originalName.replaceAll('"', '""')}"`;
    const alias = `"${c.sqlName.replaceAll('"', '""')}"`;
    return orig === alias ? orig : `${orig} AS ${alias}`;
  }).join(", ");
  const baseExpr = live.sourceKind === "table"
    ? quotedPgTable(live.sourceSchema!, live.sourceTable!)
    : `(${live.sourceSql!}) cw_live_src`;
  return withPg(live.connection, async (client) => {
    const totalCount = needCount
      ? Number((await client.query<{ cnt: string }>(`SELECT COUNT(*) AS cnt FROM ${baseExpr}`)).rows[0]?.cnt ?? 0)
      : null;
    const dataResult = await client.query<Record<string, unknown>>(
      `SELECT ${colList} FROM ${baseExpr} LIMIT ${top} OFFSET ${skip}`,
    );
    // Normaliza valores para compatibilidade com OData v4 / Power BI por tipo declarado no metadata.
    // Referência: OData JSON Format v4.0 §7 + comportamento Power BI OData connector.
    const typeMap = new Map(cols.map((c) => [c.sqlName, c.sqlType.toUpperCase().replace(/\(.*\)/, "").trim()]));
    const rows = dataResult.rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) {
        if (v === null || v === undefined) { out[k] = null; continue; }
        const t = typeMap.get(k) ?? "NVARCHAR";
        if (["DATETIME2", "DATETIME", "SMALLDATETIME", "DATETIMEOFFSET"].includes(t)) {
          // Edm.DateTimeOffset → ISO 8601 com Z
          out[k] = v instanceof Date ? v.toISOString() : v;
        } else if (t === "DATE") {
          // Edm.Date → "YYYY-MM-DD" (sem hora)
          out[k] = v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
        } else if (t === "TIME") {
          // Edm.TimeOfDay → "HH:MM:SS[.fff]"
          out[k] = String(v);
        } else if (["FLOAT", "REAL"].includes(t)) {
          // Edm.Double → NaN/Inf como strings (spec OData §7.1)
          if (typeof v === "number" && isNaN(v)) out[k] = "NaN";
          else if (typeof v === "number" && !isFinite(v)) out[k] = v > 0 ? "INF" : "-INF";
          else out[k] = v;
        } else if (["BIGINT", "DECIMAL", "NUMERIC"].includes(t)) {
          // Edm.Int64 / Edm.Decimal → string obrigatório com IEEE754Compatible=true
          out[k] = typeof v === "number" ? String(v) : v;
        } else {
          // Edm.String (NVARCHAR etc.) — bool e objetos viram string
          if (typeof v === "boolean") out[k] = String(v);
          else if (typeof v === "object" && !(v instanceof Date)) out[k] = JSON.stringify(v);
          else out[k] = v;
        }
      }
      return out;
    });
    return { rows, totalCount };
  });
}

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

export async function GET(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  try {
    const actor = await resolveODataActor(request);
    const path = (await params).path ?? [];

    if (path.length < 2) throw new ApiError(400, "BAD_REQUEST", "URL inválida. Use /api/odata/{projeto}/{dataset}");

    const [projectSlug, datasetSlug, ...rest] = path;
    const dataset = await loadDataset(projectSlug!, datasetSlug!);

    const origin = publicOrigin();
    const baseUrl = `${origin}/api/odata/${projectSlug}/${datasetSlug}`;
    const apiKey = request.nextUrl.searchParams.get("api_key");

    // Service document — não executa SQL, não precisa de syncActorGrants
    if (rest.length === 0) {
      return Response.json(buildServiceDocument(baseUrl, dataset), { headers: { "OData-Version": "4.0", "content-type": "application/json;odata.metadata=minimal;IEEE754Compatible=true" } });
    }

    // Metadata — não executa SQL, não precisa de syncActorGrants
    if (rest[0] === "$metadata") {
      return new Response(buildMetadata(dataset), {
        headers: { "content-type": "application/xml; charset=utf-8", "OData-Version": "4.0" },
      });
    }

    const tableSqlName = rest[0]!;
    const table = dataset.tables.find((t) => t.sqlName === tableSqlName);
    if (!table) throw new ApiError(404, "NOT_FOUND", "Tabela não encontrada");

    const url = request.nextUrl;
    const rawTop = parseInt(url.searchParams.get("$top") ?? "1000", 10);
    const rawSkip = parseInt(url.searchParams.get("$skip") ?? "0", 10);
    const selectParam = url.searchParams.get("$select");
    const countParam = url.searchParams.get("$count");

    const top = Math.min(Math.max(1, isNaN(rawTop) ? 1000 : rawTop), 10_000);
    const skip = Math.max(0, isNaN(rawSkip) ? 0 : rawSkip);

    const cols = selectParam
      ? table.columns.filter((c) => selectParam.split(",").map((s) => s.trim()).includes(c.sqlName))
      : table.columns;
    if (cols.length === 0) throw new ApiError(400, "BAD_REQUEST", "Nenhuma coluna válida selecionada");

    const response: Record<string, unknown> = {
      "@odata.context": `${baseUrl}/$metadata#${table.sqlName}`,
    };

    if (table.live) {
      // Tabela live — query direto ao Postgres da origem
      const { rows, totalCount } = await queryLiveTable(table.live, cols, top, skip, countParam === "true");
      const valued = rows.map((r, i) => ({ ...r, _row_number: skip + i + 1 }));
      response["value"] = valued;
      if (countParam === "true") response["@odata.count"] = totalCount;
      if (rows.length === top) {
        const next = new URL(`${baseUrl}/${table.sqlName}`);
        next.searchParams.set("$top", String(top));
        next.searchParams.set("$skip", String(skip + top));
        if (selectParam) next.searchParams.set("$select", selectParam);
        if (countParam === "true") next.searchParams.set("$count", "true");
        response["@odata.nextLink"] = appendApiKey(next, apiKey);
      }
    } else {
      // Tabela extract ou upload — query no Azure SQL com controle de permissões
      await syncActorGrants(actor);
      const colList = cols.map((c) => `[${c.sqlName}]`).join(", ");
      const sql = `SELECT ${colList}, ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS [_row_number] FROM [${dataset.schemaName}].[${table.sqlName}] ORDER BY (SELECT NULL) OFFSET ${skip} ROWS FETCH NEXT ${top} ROWS ONLY`;
      const result = await executeReadOnly(actor.principal, sql, 120, top, [dataset.schemaName]);
      response["value"] = result.rows;
      if (countParam === "true") {
        const countSql = `SELECT COUNT(*) AS [cnt] FROM [${dataset.schemaName}].[${table.sqlName}]`;
        const cr = await executeReadOnly(actor.principal, countSql, 30, 1, [dataset.schemaName]);
        response["@odata.count"] = Number((cr.rows[0] as Record<string, unknown>)?.cnt ?? 0);
      }
      if (result.rows.length === top) {
        const next = new URL(`${baseUrl}/${table.sqlName}`);
        next.searchParams.set("$top", String(top));
        next.searchParams.set("$skip", String(skip + top));
        if (selectParam) next.searchParams.set("$select", selectParam);
        if (countParam === "true") next.searchParams.set("$count", "true");
        response["@odata.nextLink"] = appendApiKey(next, apiKey);
      }
    }

    return Response.json(response, { headers: { "OData-Version": "4.0", "content-type": "application/json;odata.metadata=minimal;IEEE754Compatible=true" } });
  } catch (e) {
    if (process.env.NODE_ENV !== "production" && !(e instanceof ApiError)) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ debug: msg }, { status: 500 });
    }
    return handleApiError(e);
  }
}
