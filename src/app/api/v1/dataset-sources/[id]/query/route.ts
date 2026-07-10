import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/server/db";
import { resolveActor } from "@/server/auth/actor";
import { canAccess } from "@/server/auth/permissions";
import { ApiError, handleApiError, ok } from "@/server/http";
import { executePostgresReadOnly, quotedPgTable } from "@/server/connections/postgres";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(request);
    const input = z.object({ sql: z.string().min(1).max(50000).optional(), timeout: z.number().int().min(1).max(120).default(30), limit: z.number().int().min(1).max(10000).default(10000), offset: z.number().int().min(0).default(0) }).parse(await request.json());
    const source = await prisma.datasetSource.findUniqueOrThrow({ where: { id: (await params).id }, include: { dataset: true, connection: true, targetTable: true } });
    if (!await canAccess(actor, "READ", source.dataset.projectId, source.datasetId) && actor.role !== "ADMIN") throw new ApiError(403, "FORBIDDEN", "Sem permissao para ler a fonte");
    if (source.mode !== "live") throw new ApiError(400, "NOT_LIVE", "Fonte nao e live");
    const sql = input.sql
      ? qualifySourceReference(input.sql, source)
      : source.sourceKind === "table" ? `SELECT * FROM ${quotedPgTable(source.sourceSchema!, source.sourceTable!)}` : source.sourceSql!;
    return ok(await executePostgresReadOnly(source.connection, sql, input.timeout, input.limit, input.offset));
  } catch (e) {
    if (e instanceof Error && "code" in e) return handleApiError(new ApiError(400, "POSTGRES_QUERY_FAILED", e.message));
    return handleApiError(e);
  }
}

function qualifySourceReference(sql: string, source: { sourceKind: string; sourceSchema: string | null; sourceTable: string | null; sourceSql: string | null; targetTable: { name: string; sqlName: string } | null }) {
  if (source.sourceKind === "table" && source.sourceSchema && source.sourceTable) {
    const quoted = quotedPgTable(source.sourceSchema, source.sourceTable);
    return replaceTableRefs(sql, [source.sourceTable], (alias) => alias ? `${quoted} ${quotePgAlias(alias)}` : quoted);
  }
  if (source.sourceKind === "query" && source.sourceSql && source.targetTable) {
    const statement = source.sourceSql.trim().replace(/;+\s*$/, "");
    return replaceTableRefs(sql, [source.targetTable.sqlName, source.targetTable.name], (alias) => `(${statement}) ${quotePgAlias(alias ?? source.targetTable!.sqlName)}`);
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
