import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { resolveActor } from "@/server/auth/actor";
import { canAccess } from "@/server/auth/permissions";
import { ensureInternalPrincipal, executeReadOnly, grantSchema } from "@/server/azure/sql";
import { executeLiveReadOnly, liveQuotedTable, type LiveConnection } from "@/server/connections/live";
import { getStorageConnection } from "@/server/storage/connection";
import { ApiError, handleApiError, ok } from "@/server/http";
import { quoteIdentifier } from "@/server/security/naming";
import { tombstoneTableName } from "@/server/storage/delete-detection";
import { getTombstoneTtlDays } from "@/server/storage/tombstone-ttl";
import { decodeCursor, pgRemovedSql, pgRowsPageSql, removedIncomplete, removedKeysSql, REMOVED_CAP, settleFirstPage, shapeRowsPage, TIE_CAP, type Cursor, type PageRow } from "@/server/tables/since";

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

    // limit: inteiro >= 0 (padrao 100, maximo 1000). Antes "abc" ou "-5" davam 500.
    const limitRaw = request.nextUrl.searchParams.get("limit");
    let limit = 100;
    if (limitRaw !== null && limitRaw.trim() !== "") {
      const n = Number(limitRaw);
      if (!Number.isInteger(n) || n < 0) throw new ApiError(400, "VALIDATION_ERROR", "\"limit\" precisa ser um inteiro >= 0");
      limit = Math.min(n, 1000);
    }
    const sinceRaw = request.nextUrl.searchParams.get("since");
    const cursorRaw = request.nextUrl.searchParams.get("cursor");

    if (sinceRaw && table.source?.mode === "live") {
      throw new ApiError(400, "SINCE_NOT_SUPPORTED", "\"since\" só é suportado em fontes extract (fontes live não têm cópia local para comparar).");
    }
    let since: Date | null = null;
    if (sinceRaw) {
      since = new Date(sinceRaw);
      if (isNaN(since.getTime())) throw new ApiError(400, "INVALID_SINCE", "\"since\" precisa ser uma data ISO válida");
    }
    // cursor (aditivo): continua a pagina seguinte de um `since` com mais linhas que o limit — ver server/tables/since.ts
    let cursor: Cursor | null = null;
    if (cursorRaw) {
      if (!since) throw new ApiError(400, "INVALID_CURSOR", "\"cursor\" exige \"since\"");
      cursor = decodeCursor(cursorRaw);
      if (!cursor) throw new ApiError(400, "INVALID_CURSOR", "\"cursor\" invalido");
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
    const runReadOnly = async (sqlStr: string, rowLimit = limit) => {
      if (conn.provider === "postgres") return conn.query<Record<string, unknown>>(sqlStr);
      await ensureInternalPrincipal(actor.principal, table.dataset.storageServerId);
      await grantSchema(actor.principal, table.dataset.schemaName, "READ", table.dataset.storageServerId);
      const result = await executeReadOnly(actor.principal, sqlStr, 30, rowLimit, [], 0, 120, table.dataset.storageServerId);
      return result.rows as Record<string, unknown>[];
    };

    if (since) {
      const sinceLit = `'${sqlDateLiteral(since)}'`;
      const qSyncedAt = conn.q("cw_synced_at");
      const qDeletedAt = conn.q("cw_deleted_at");
      // Exclusoes na origem: chaves removidas ficam em `cw_tomb_<tabela>` (lapide; ver docs/source-contract.md),
      // unidas as linhas legadas com cw_deleted_at (tabelas ainda nao convertidas).
      const tombName = tombstoneTableName(table.sqlName);
      const qTomb = keyColumn && await conn.tableExists(table.dataset.schemaName, tombName) ? `${qSchema}.${conn.q(tombName)}` : null;
      const tombCols = { qTomb, qTombKey: conn.q("cw_key"), qTombAt: conn.q("cw_deleted_at") };
      // `since` mais antigo que a validade das lapides: removedKeys pode estar incompleto (consumidor deve ressincronizar).
      const removedIncompleteFlag = keyColumn ? removedIncomplete(since, await getTombstoneTtlDays()) : false;

      if (conn.provider === "postgres") {
        // Paginacao sem perda: ordem (cw_synced_at, chave) + cursor; nextSince conservador. (Ver since.ts.)
        const qKey = keyColumn ? conn.q(keyColumn) : null;
        const keySqlType = table.columns.find((c) => c.sqlName === keyColumn)?.sqlType ?? "NVARCHAR(MAX)";
        if (cursor && !qKey) throw new ApiError(400, "INVALID_CURSOR", "\"cursor\" exige tabela com chave (upsert)");
        let pageSql: string;
        try {
          pageSql = pgRowsPageSql({ qTarget, colList, qSynced: qSyncedAt, qDeleted: qDeletedAt, qKey, keySqlType, sinceLit, cursor, limit });
        } catch {
          throw new ApiError(400, "INVALID_CURSOR", "\"cursor\" invalido");
        }
        const raw = await conn.query<PageRow>(pageSql);
        const shaped = cursor
          ? shapeRowsPage(raw, limit, since)
          : await settleFirstPage(raw, limit, since, () =>
              conn.query<PageRow>(pgRowsPageSql({ qTarget, colList, qSynced: qSyncedAt, qDeleted: qDeletedAt, qKey, keySqlType, sinceLit, cursor: null, limit: TIE_CAP })));
        const rows = shaped.page.map((r) => {
          const { __cw_synced_at, __cw_synced_txt, __cw_key, ...rest } = r;
          void __cw_synced_at; void __cw_synced_txt; void __cw_key;
          return rest;
        });

        // Exclusoes: so na 1a pagina (nas do cursor ja foram entregues). Sem o teto de `limit` de antes.
        let removedKeys: unknown[] | null = null;
        let maxDeletedAt: Date | null = null;
        let removedTruncated = false;
        if (qKey) {
          removedKeys = [];
          if (!cursor) {
            const removed = await conn.query<{ k: unknown; d: unknown }>(pgRemovedSql({ qTarget, qDeleted: qDeletedAt, qKey, sinceLit, ...tombCols }));
            removedTruncated = removed.length > REMOVED_CAP;
            for (const r of removed.slice(0, REMOVED_CAP)) {
              removedKeys.push(r.k);
              const d = r.d instanceof Date ? r.d : new Date(String(r.d));
              if (!maxDeletedAt || d > maxDeletedAt) maxDeletedAt = d;
            }
          }
        }
        let nextSince = shaped.nextSince;
        if (!shaped.hasMore && !removedTruncated && maxDeletedAt && maxDeletedAt > nextSince) nextSince = maxDeletedAt;

        return ok(rows, {
          columns: colNames,
          rowCount: rows.length,
          removedKeys,
          nextSince: nextSince.toISOString(),
          hasMore: shaped.hasMore,
          ...(shaped.nextCursor ? { nextCursor: shaped.nextCursor } : {}),
          ...(removedTruncated ? { removedTruncated: true } : {}),
          ...(removedIncompleteFlag ? { removedIncomplete: true } : {}),
          ...(shaped.tieGroupTruncated ? { tieGroupTruncated: true } : {}),
        });
      }

      // SQL Server: comportamento anterior (nao verificado por falta de instancia; ainda sujeito ao limite de empates).
      // Inclui cw_synced_at na própria query (pra achar o "carimbo" desta página sem
      // outra ida ao banco), removido da linha antes de devolver ao consumidor. No
      // MSSQL, o LIMIT já é aplicado pelo próprio executeReadOnly (via runReadOnly) a
      // partir do ORDER BY — não repetir aqui pra não colidir com a paginação dele.
      const pageClause = (orderCol: string) => conn.provider === "postgres"
        ? `ORDER BY ${orderCol} ASC LIMIT ${limit}`
        : `ORDER BY ${orderCol} ASC`;
      // Pede limit+1 para saber se ha mais (hasMore honesto: o SDK com follow=True depende dele para continuar).
      const rawFetched = await runReadOnly(
        `SELECT ${colList}, ${qSyncedAt} AS __cw_synced_at FROM ${qTarget} WHERE ${qDeletedAt} IS NULL AND ${qSyncedAt} > ${sinceLit} ${pageClause(qSyncedAt)}`,
        limit + 1,
      );
      const mssqlHasMore = rawFetched.length > limit;
      const rawRows = mssqlHasMore ? rawFetched.slice(0, limit) : rawFetched;
      let maxSyncedAt: Date | null = null;
      const rows = rawRows.map((row) => {
        const { __cw_synced_at, ...rest } = row;
        const d = __cw_synced_at instanceof Date ? __cw_synced_at : new Date(String(__cw_synced_at));
        if (!maxSyncedAt || d > maxSyncedAt) maxSyncedAt = d;
        return rest;
      });

      let removedKeys: unknown[] | null = null;
      let maxDeletedAt: Date | null = null;
      let mssqlRemovedTruncated = false;
      if (keyColumn) {
        const qKey = conn.q(keyColumn);
        const removedFetched = await runReadOnly(
          removedKeysSql({ qTarget, qDeleted: qDeletedAt, qKey, sinceLit, ...tombCols }),
          limit + 1,
        ) as { k: unknown; d: unknown }[];
        mssqlRemovedTruncated = removedFetched.length > limit;
        const removed = mssqlRemovedTruncated ? removedFetched.slice(0, limit) : removedFetched;
        removedKeys = removed.map(r => r.k);
        for (const r of removed) {
          const d = r.d instanceof Date ? r.d : new Date(String(r.d));
          if (!maxDeletedAt || d > maxDeletedAt) maxDeletedAt = d;
        }
      }

      // Como no Postgres: exclusoes so adiantam o nextSince quando nao ha mais linhas a buscar (senao pularia linhas alteradas).
      const candidates = [maxSyncedAt, mssqlHasMore ? null : maxDeletedAt].filter((d): d is Date => d != null);
      const nextSince = candidates.length ? new Date(Math.max(...candidates.map(d => d.getTime()))) : since;

      return ok(rows, {
        columns: colNames,
        rowCount: rows.length,
        removedKeys,
        nextSince: nextSince.toISOString(),
        hasMore: mssqlHasMore || mssqlRemovedTruncated,
        ...(mssqlRemovedTruncated ? { removedTruncated: true } : {}),
        ...(removedIncompleteFlag ? { removedIncomplete: true } : {}),
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
