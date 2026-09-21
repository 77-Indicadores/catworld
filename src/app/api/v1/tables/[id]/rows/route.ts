import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { resolveActor } from "@/server/auth/actor";
import { canAccess } from "@/server/auth/permissions";
import { ensureInternalPrincipal, executeReadOnly, grantSchema } from "@/server/azure/sql";
import { executeLiveReadOnly, liveQuotedTable, type LiveConnection } from "@/server/connections/live";
import { getStorageConnection } from "@/server/storage/connection";
import { activeRowsPredicate } from "@/server/storage/active-rows";
import { ApiError, handleApiError, ok } from "@/server/http";
import { quoteIdentifier } from "@/server/security/naming";
import {
  BASELINE_SINCE_TXT, decodeCursor, finalizeNextSince, normTs, parseSince, PG_NOW_TXT_SQL, pgRemovedSql, pgRowsPageSql,
  REMOVED_CAP, rowStampsOf, safetyWindowMs, settleFirstPage, shapeRowsPage, TIE_CAP,
  type Cursor, type PageRow, type ParsedSince,
} from "@/server/tables/since";

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
    const wantStamps = request.nextUrl.searchParams.get("stamps") === "1";
    let parsedSince: ParsedSince | null = null;
    if (sinceRaw) {
      parsedSince = parseSince(sinceRaw); // UTC (sem fuso = UTC), microssegundos; nunca usa o fuso do Node
      if (!parsedSince) throw new ApiError(400, "INVALID_SINCE", "\"since\" precisa ser uma data ISO valida (ex.: 2026-09-19T10:00:00.123456Z)");
    }
    // so o ramo MSSQL (legado) ainda usa Date (ms)
    const since: Date | null = parsedSince ? new Date(parsedSince.iso.replace(/(\.\d{3})\d{3}Z$/, "$1Z")) : null;
    // cursor (aditivo): carrega o estado inteiro e tambem pagina o BASELINE (sem `since`) — ver server/tables/since.ts
    let cursor: Cursor | null = null;
    if (cursorRaw) {
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

    if (conn.provider === "postgres") {   // "live" ja retornou acima; vale tambem SEM `since` (baseline paginado)
      const qSyncedAt = conn.q("cw_synced_at");
      const qDeletedAt = conn.q("cw_deleted_at");
      const isBaseline = !parsedSince;
      const sinceTxt = parsedSince?.txt ?? BASELINE_SINCE_TXT;
      const sinceLit = `'${sinceTxt}'`;
      const qKey = keyColumn ? conn.q(keyColumn) : null;
      const keySqlType = table.columns.find((c) => c.sqlName === keyColumn)?.sqlType ?? "NVARCHAR(MAX)";
      if (cursor && !qKey) throw new ApiError(400, "INVALID_CURSOR", "\"cursor\" exige tabela com chave (upsert)");
      const mkSql = (lim: number, cur: Cursor | null) =>
        pgRowsPageSql({ qTarget, colList, qSynced: qSyncedAt, qDeleted: qDeletedAt, qKey, keySqlType, sinceLit, cursor: cur, limit: lim });
      let pageSql: string;
      try { pageSql = mkSql(limit, cursor); } catch { throw new ApiError(400, "INVALID_CURSOR", "\"cursor\" invalido"); }
      let raw: PageRow[] | null = null;
      try {
        raw = await conn.query<PageRow>(pageSql);
      } catch (e) {
        // Tabela anterior a feature (sem cw_synced_at): so o baseline cai no caminho antigo (abaixo); com `since` o erro sobe.
        if (!(isBaseline && (e as { code?: string }).code === "42703")) throw e;
      }
      if (raw) {
        const shaped = cursor
          ? shapeRowsPage(raw, limit, sinceTxt)
          : await settleFirstPage(raw, limit, sinceTxt, () => conn.query<PageRow>(mkSql(TIE_CAP, null)));
        const stamps = wantStamps ? rowStampsOf(shaped.page) : null;
        const rows = shaped.page.map((r) => {
          const { __cw_synced_at, __cw_synced_txt, __cw_key, ...rest } = r;
          void __cw_synced_at; void __cw_synced_txt; void __cw_key;
          return rest;
        });

        // Exclusoes: so na 1a pagina de um `since` (baseline nao lista excluidas; paginas de cursor ja as entregaram).
        let removedKeys: unknown[] | null = null;
        let removedMaxTxt: string | null = null;
        let removedTruncated = false;
        if (qKey && !isBaseline) {
          removedKeys = [];
          if (!cursor) {
            const removed = await conn.query<{ k: unknown; d: unknown }>(pgRemovedSql({ qTarget, qDeleted: qDeletedAt, qKey, sinceLit }));
            removedTruncated = removed.length > REMOVED_CAP;
            for (const r of removed.slice(0, REMOVED_CAP)) {
              removedKeys.push(r.k);
              const d = normTs(String(r.d)); // TEXTO do banco: sem Date, sem fuso do Node
              if (d && (!removedMaxTxt || d > removedMaxTxt)) removedMaxTxt = d;
            }
          }
        }
        const nowTxt = (await conn.query<{ n: string }>(PG_NOW_TXT_SQL))[0]?.n ?? "";
        const nextSince = finalizeNextSince({ settled: shaped, since: sinceTxt, removedMaxTxt, removedTruncated, nowTxt, windowMs: safetyWindowMs() });

        return ok(rows, {
          columns: colNames.length ? colNames : (rows.length ? Object.keys(rows[0]!) : []),
          rowCount: rows.length,
          removedKeys,
          nextSince,                       // ISO UTC com 6 casas: guarde como TEXTO
          hasMore: shaped.hasMore,
          ...(shaped.nextCursor ? { nextCursor: shaped.nextCursor } : {}),
          ...(stamps ? { rowStamps: stamps } : {}),        // dedupe no cliente (janela de seguranca)
          ...(removedTruncated ? { removedTruncated: true } : {}),
          ...(shaped.tieGroupTruncated ? { tieGroupTruncated: true } : {}),
          safetyWindowSec: Math.round(safetyWindowMs() / 1000),
        });
      }
    }

    if (since) {
      const sinceLit = `'${sqlDateLiteral(since)}'`;
      const qSyncedAt = conn.q("cw_synced_at");
      const qDeletedAt = conn.q("cw_deleted_at");

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
          `SELECT ${qKey} AS k, ${qDeletedAt} AS d FROM ${qTarget} WHERE ${qDeletedAt} > ${sinceLit} ${pageClause(qDeletedAt)}`,
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
      // Lido como TEXTO: o Date do driver depende do fuso do processo. `parseSince` assume UTC (sem fuso = UTC).
      const cast = conn.provider === "postgres" ? `MAX(${conn.q("cw_synced_at")})::text` : `CONVERT(varchar(30), MAX(${conn.q("cw_synced_at")}), 126)`;
      const maxRes = await conn.query<{ v: unknown }>(`SELECT ${cast} AS v FROM ${qTarget}`);
      const v = maxRes[0]?.v;
      if (v != null) nextSinceBaseline = parseSince(String(v))?.iso ?? null;
    } catch { /* tabela pode não ter cw_synced_at ainda (dados anteriores à feature) */ }

    // Amostra sem `since`: linha marcada como excluida (soft delete) nao e dado. Le como dono (a RLS nao vale): filtra aqui.
    const activeWhere = await activeRowsPredicate(conn, table.dataset.schemaName, table.sqlName);
    const activeSql = activeWhere ? ` WHERE ${activeWhere}` : "";
    if (conn.provider === "postgres") {
      const rows = await conn.query<Record<string, unknown>>(`SELECT ${colList} FROM ${qTarget}${activeSql} LIMIT ${limit}`);
      return ok(rows, { columns: colNames.length ? colNames : (rows.length ? Object.keys(rows[0]!) : []), rowCount: rows.length, nextSince: nextSinceBaseline });
    }

    // MSSQL: grant de schema + query via executeReadOnly
    await ensureInternalPrincipal(actor.principal, table.dataset.storageServerId);
    await grantSchema(actor.principal, table.dataset.schemaName, "READ", table.dataset.storageServerId);
    const result = await executeReadOnly(
      actor.principal,
      `SELECT TOP ${limit} ${colNames.length ? colNames.map(c => quoteIdentifier(c)).join(", ") : "*"} FROM ${quoteIdentifier(table.dataset.schemaName)}.${quoteIdentifier(table.sqlName)}${activeSql}`,
      30, limit, [], 0, 120, table.dataset.storageServerId,
    );
    return ok(result.rows, { columns: result.columns, rowCount: result.rowCount, nextSince: nextSinceBaseline });
  } catch (e) {
    return handleApiError(e);
  }
}
