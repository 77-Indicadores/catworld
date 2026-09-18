import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { resolveActor } from "@/server/auth/actor";
import { canAccess } from "@/server/auth/permissions";
import { ensureInternalPrincipal, executeReadOnly, grantSchema } from "@/server/azure/sql";
import { executeLiveReadOnly, liveQuotedTable, type LiveConnection } from "@/server/connections/live";
import { getStorageConnection } from "@/server/storage/connection";
import { ApiError, handleApiError, ok } from "@/server/http";
import { quoteIdentifier } from "@/server/security/naming";

/** Formata Date como literal SQL seguro (ISO, sem interpolação de input livre). */
function sqlDateLiteral(d: Date): string {
  return d.toISOString().slice(0, 23).replace("T", " ");
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(request);
    const table = await prisma.datasetTable.findUniqueOrThrow({
      where: { id: (await params).id },
      include: { dataset: true, source: { include: { connection: true } }, columns: { orderBy: { ordinal: "asc" } } },
    });
    if (!(await canAccess(actor, "READ", table.dataset.projectId, table.dataset.id)) && actor.role !== "ADMIN")
      throw new ApiError(403, "FORBIDDEN", "Sem acesso ao dataset");

    const limit = Math.min(Number(request.nextUrl.searchParams.get("limit") ?? 100), 1000);
    const sinceRaw = request.nextUrl.searchParams.get("since");

    if (sinceRaw && table.source?.mode === "live") {
      throw new ApiError(400, "SINCE_NOT_SUPPORTED", "\"since\" só é suportado em fontes extract (fontes live não têm cópia local para comparar).");
    }
    let since: Date | null = null;
    if (sinceRaw) {
      since = new Date(sinceRaw);
      if (isNaN(since.getTime())) throw new ApiError(400, "INVALID_SINCE", "\"since\" precisa ser uma data ISO válida");
    }

    // Live source (PostgreSQL connection via DatasetSource)
    if (table.source?.mode === "live") {
      const source = table.source;
      const sql = source.sourceKind === "table"
        ? `SELECT * FROM ${liveQuotedTable(source.connection, source.sourceSchema!, source.sourceTable!)}`
        : source.sourceSql!;
      const result = await executeLiveReadOnly(source.connection as LiveConnection, sql, 30, limit);
      return ok(result.rows, { columns: result.columns, rowCount: result.rowCount, source: { id: source.id, mode: source.mode } });
    }

    const colNames = table.columns.map(c => c.sqlName);
    const keyColumn = table.source?.keyColumn ?? null;
    const conn = await getStorageConnection(table.dataset.storageServerId);
    const qSchema = conn.q(table.dataset.schemaName);
    const qTable = conn.q(table.sqlName);
    const qTarget = `${qSchema}.${qTable}`;
    const colList = colNames.length ? colNames.map(c => conn.q(c)).join(", ") : "*";

    // No MSSQL, toda leitura passa pelo principal do actor (grant de schema por sessão),
    // nunca pela conexão administrativa do storage — vale tanto pro caminho "since" abaixo
    // quanto pro fallback sem "since" mais adiante.
    const runReadOnly = async (sqlStr: string) => {
      if (conn.provider === "postgres") return conn.query<Record<string, unknown>>(sqlStr);
      await ensureInternalPrincipal(actor.principal, table.dataset.storageServerId);
      await grantSchema(actor.principal, table.dataset.schemaName, "READ", table.dataset.storageServerId);
      const result = await executeReadOnly(actor.principal, sqlStr, 30, limit, [], 0, 120, table.dataset.storageServerId);
      return result.rows as Record<string, unknown>[];
    };

    if (since) {
      const sinceLit = `'${sqlDateLiteral(since)}'`;
      const qSyncedAt = conn.q("cw_synced_at");
      const qDeletedAt = conn.q("cw_deleted_at");

      // Inclui cw_synced_at na própria query (pra achar o "carimbo" desta página sem
      // outra ida ao banco), removido da linha antes de devolver ao consumidor. No
      // MSSQL, o LIMIT já é aplicado pelo próprio executeReadOnly (via runReadOnly) a
      // partir do ORDER BY — não repetir aqui pra não colidir com a paginação dele.
      const pageClause = (orderCol: string) => conn.provider === "postgres"
        ? `ORDER BY ${orderCol} ASC LIMIT ${limit}`
        : `ORDER BY ${orderCol} ASC`;
      const rawRows = await runReadOnly(
        `SELECT ${colList}, ${qSyncedAt} AS __cw_synced_at FROM ${qTarget} WHERE ${qDeletedAt} IS NULL AND ${qSyncedAt} > ${sinceLit} ${pageClause(qSyncedAt)}`,
      );
      let maxSyncedAt: Date | null = null;
      const rows = rawRows.map((row) => {
        const { __cw_synced_at, ...rest } = row;
        const d = __cw_synced_at instanceof Date ? __cw_synced_at : new Date(String(__cw_synced_at));
        if (!maxSyncedAt || d > maxSyncedAt) maxSyncedAt = d;
        return rest;
      });

      let removedKeys: unknown[] | null = null;
      let maxDeletedAt: Date | null = null;
      if (keyColumn) {
        const qKey = conn.q(keyColumn);
        const removed = await runReadOnly(
          `SELECT ${qKey} AS k, ${qDeletedAt} AS d FROM ${qTarget} WHERE ${qDeletedAt} > ${sinceLit} ${pageClause(qDeletedAt)}`,
        ) as { k: unknown; d: unknown }[];
        removedKeys = removed.map(r => r.k);
        for (const r of removed) {
          const d = r.d instanceof Date ? r.d : new Date(String(r.d));
          if (!maxDeletedAt || d > maxDeletedAt) maxDeletedAt = d;
        }
      }

      const candidates = [maxSyncedAt, maxDeletedAt].filter((d): d is Date => d != null);
      const nextSince = candidates.length ? new Date(Math.max(...candidates.map(d => d.getTime()))) : since;

      return ok(rows, {
        columns: colNames,
        rowCount: rows.length,
        removedKeys,
        nextSince: nextSince.toISOString(),
      });
    }

    // Sem "since": comportamento normal, tabela inteira (colunas internas nunca entram
    // na lista, já que colList vem do catálogo DatasetColumn). Ainda assim, calcula
    // nextSince (MAX(cw_synced_at) da tabela) pra fechar o ciclo de polling do SDK —
    // primeira chamada sem since, chamadas seguintes já usando `since=nextSince`.
    // Só um agregado escalar (nenhum dado de linha exposto) — direto via conn.query,
    // sem passar pelo fluxo de grant por principal do MSSQL.
    let nextSinceBaseline: string | null = null;
    try {
      const maxRes = await conn.query<{ v: unknown }>(`SELECT MAX(${conn.q("cw_synced_at")}) AS v FROM ${qTarget}`);
      const v = maxRes[0]?.v;
      if (v != null) nextSinceBaseline = (v instanceof Date ? v : new Date(String(v))).toISOString();
    } catch { /* tabela pode não ter cw_synced_at ainda (dados anteriores à feature) */ }

    if (conn.provider === "postgres") {
      const rows = await conn.query<Record<string, unknown>>(`SELECT ${colList} FROM ${qTarget} LIMIT ${limit}`);
      return ok(rows, { columns: colNames.length ? colNames : (rows.length ? Object.keys(rows[0]!) : []), rowCount: rows.length, nextSince: nextSinceBaseline });
    }

    // MSSQL: grant de schema + query via executeReadOnly
    await ensureInternalPrincipal(actor.principal, table.dataset.storageServerId);
    await grantSchema(actor.principal, table.dataset.schemaName, "READ", table.dataset.storageServerId);
    const result = await executeReadOnly(
      actor.principal,
      `SELECT TOP ${limit} ${colNames.length ? colNames.map(c => quoteIdentifier(c)).join(", ") : "*"} FROM ${quoteIdentifier(table.dataset.schemaName)}.${quoteIdentifier(table.sqlName)}`,
      30, limit, [], 0, 120, table.dataset.storageServerId,
    );
    return ok(result.rows, { columns: result.columns, rowCount: result.rowCount, nextSince: nextSinceBaseline });
  } catch (e) {
    return handleApiError(e);
  }
}
