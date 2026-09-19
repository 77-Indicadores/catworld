import type { NextRequest } from "next/server";
import { z } from "zod";
import * as Sentry from "@sentry/nextjs";
import { prisma } from "@/server/db";
import { resolveActor } from "@/server/auth/actor";
import { canAccess } from "@/server/auth/permissions";
import { ApiError, handleApiError, ok } from "@/server/http";
import { executePostgresReadOnly, quotedPgTable } from "@/server/connections/postgres";
import { executeMssqlReadOnly, quotedMssqlTable } from "@/server/connections/mssql";
import { runWithContract } from "@/server/sql-contract/apply";
import { SqlContractError } from "@/server/sql-contract/translate";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(request);
    const input = z.object({ sql: z.string().min(1).max(50000).optional(), timeout: z.number().int().min(1).max(120).default(30), limit: z.number().int().min(1).max(10000).default(10000), offset: z.number().int().min(0).default(0), normalize: z.boolean().default(false) }).parse(await request.json());
    const source = await prisma.datasetSource.findUniqueOrThrow({ where: { id: (await params).id }, include: { dataset: true, connection: true, targetTable: true } });
    if (!await canAccess(actor, "READ", source.dataset.projectId, source.datasetId) && actor.role !== "ADMIN") throw new ApiError(403, "FORBIDDEN", "Sem permissao para ler a fonte");
    if (source.mode !== "live") throw new ApiError(400, "NOT_LIVE", "Fonte nao e live");
    const isMssql = source.connection.provider === "mssql";
    const tableRef = isMssql ? quotedMssqlTable(source.sourceSchema!, source.sourceTable!) : quotedPgTable(source.sourceSchema!, source.sourceTable!);
    // Contrato de SQL: o usuario escreve T-SQL; origem Postgres recebe a traducao.
    // O SQL nativo da propria fonte (sourceSql / SELECT *) ja esta no dialeto da origem.
    const execute = async (translated: { sql: string; topLimit: number | null } | null) => {
      const query = translated
        ? qualifySourceReference(translated.sql, source, isMssql)
        : source.sourceKind === "table" ? `SELECT * FROM ${tableRef}` : source.sourceSql!;
      const limit = translated?.topLimit != null ? Math.min(translated.topLimit, 10000) : input.limit;
      const result = isMssql
        ? await executeMssqlReadOnly(source.connection, query, input.timeout, limit, input.offset, input.normalize)
        : await executePostgresReadOnly(source.connection, query, input.timeout, limit, input.offset, input.normalize);
      // TOP n pedido pelo usuario nao e truncamento (o corte e intencional)
      return translated?.topLimit != null ? { ...result, truncated: false } : result;
    };
    const result = input.sql
      ? await runWithContract(input.sql, isMssql ? "mssql" : "postgres", isMssql ? "live-mssql" : "live-pg", "passthrough", execute)
      : await execute(null);
    return ok(result);
  } catch (e) {
    // Compatibilidade: todo erro com "code" continua virando QUERY_FAILED (comportamento anterior);
    // so o erro novo do contrato de SQL mantem o proprio codigo.
    if (e instanceof SqlContractError) return handleApiError(e);
    if (e instanceof Error && "code" in e) {
      Sentry.captureException(e);
      return handleApiError(new ApiError(400, "QUERY_FAILED", e.message));
    }
    return handleApiError(e);
  }
}

function qualifySourceReference(sql: string, source: { sourceKind: string; sourceSchema: string | null; sourceTable: string | null; sourceSql: string | null; targetTable: { name: string; sqlName: string } | null }, isMssql = false) {
  const quoteAlias = isMssql ? quoteMssqlAlias : quotePgAlias;
  const quoteTable = (schema: string, table: string) => isMssql ? quotedMssqlTable(schema, table) : quotedPgTable(schema, table);
  if (source.sourceKind === "table" && source.sourceSchema && source.sourceTable) {
    const quoted = quoteTable(source.sourceSchema, source.sourceTable);
    return replaceTableRefs(sql, [source.sourceTable], (alias) => alias ? `${quoted} ${quoteAlias(alias)}` : quoted);
  }
  if (source.sourceKind === "query" && source.sourceSql && source.targetTable) {
    const statement = source.sourceSql.trim().replace(/;+\s*$/, "");
    return replaceTableRefs(sql, [source.targetTable.sqlName, source.targetTable.name], (alias) => `(${statement}) ${quoteAlias(alias ?? source.targetTable!.sqlName)}`);
  }
  return sql;
}

function replaceTableRefs(sql: string, names: string[], replacement: (alias?: string) => string) {
  return rewriteSqlOutsideLiterals(sql, (chunk) => {
    let out = chunk;
    const stopWords = "where|join|left|right|full|inner|cross|on|group|order|having|limit|offset|union|except|intersect|fetch|for";
    const aliasPattern = `(?:\\s+(?:as\\s+)?("?[a-z_][a-z0-9_]*"?))?(?=\\s*(?:${stopWords})\\b|\\s*[,;)]|\\s*$)`;
    const aliasStop = new RegExp(`^(?:${stopWords})$`, "i");
    for (const name of [...new Set(names.filter(Boolean))]) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(`\\b(FROM|JOIN)\\s+("${escaped}"|${escaped})\\b${aliasPattern}`, "gi"), (_match, keyword: string, _table: string, rawAlias?: string) => {
        const alias = rawAlias?.replace(/^"|"$/g, "");
        return `${keyword} ${replacement(alias && !aliasStop.test(alias) ? alias : undefined)}`;
      });
    }
    return out;
  });
}

function rewriteSqlOutsideLiterals(sql: string, rewrite: (chunk: string) => string) {
  let out = "", chunk = "", i = 0, state: "normal" | "single" | "line" | "block" = "normal";
  const flush = () => { if (chunk) { out += rewrite(chunk); chunk = ""; } };
  while (i < sql.length) {
    const c = sql[i], n = sql[i + 1];
    if (state === "normal") {
      if (c === "'") { flush(); state = "single"; out += c; }
      else if (c === "-" && n === "-") { flush(); state = "line"; out += c + n; i++; }
      else if (c === "/" && n === "*") { flush(); state = "block"; out += c + n; i++; }
      else chunk += c;
    } else if (state === "single") {
      out += c;
      if (c === "'" && n === "'") { out += n; i++; }
      else if (c === "'") state = "normal";
    } else if (state === "line") {
      out += c;
      if (c === "\n") state = "normal";
    } else {
      out += c;
      if (c === "*" && n === "/") { out += n; i++; state = "normal"; }
    }
    i++;
  }
  flush();
  return out;
}

function quotePgAlias(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteMssqlAlias(value: string) {
  return `[${value.replaceAll("]", "]]")}]`;
}
