/**
 * Quais SCHEMAS um SQL referencia — usado para impedir que quem so tem acesso a um dataset leia outro
 * por dentro de uma tabela derivada (o SQL da derivada roda com a conta administrativa do storage).
 */
import { Parser } from "node-sql-parser";
import { ApiError } from "@/server/http";
import { accessibleDatasets } from "@/server/auth/permissions";
import type { Actor } from "@/server/auth/actor";

const parser = new Parser();

/** Schemas citados (minusculos, sem duplicatas). Nome sem schema (`FROM t`, CTE) nao entra. */
export function referencedSchemas(sql: string): string[] {
  const out = new Set<string>();
  try {
    for (const entry of parser.tableList(sql, { database: "transactsql" })) {
      const schema = entry.split("::")[1];
      if (!schema || schema === "null") continue;
      out.add(schema.split(".").at(-1)!.toLowerCase()); // db.schema -> schema
    }
    return [...out];
  } catch {
    // SQL fora do subconjunto T-SQL (ex: sintaxe Postgres): cai numa varredura por FROM/JOIN schema.tabela
    const re = /\b(?:FROM|JOIN)\s+(?:\[([^\]]+)\]|"([^"]+)"|([A-Za-z_][\w$]*))\s*\.\s*(?:\[[^\]]+\]|"[^"]+"|[A-Za-z_][\w$]*)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) out.add((m[1] ?? m[2] ?? m[3] ?? "").toLowerCase());
    return [...out];
  }
}

/**
 * ADMIN passa. Os demais so podem referenciar o schema do PROPRIO dataset e os de datasets que podem ler.
 * (Derivada que junta dois datasets continua funcionando para quem le os dois.)
 */
export async function assertSqlSchemasAllowed(actor: Actor, sql: string, ownSchema: string): Promise<void> {
  if (actor.type === "user" && actor.role === "ADMIN") return;
  const refs = referencedSchemas(sql);
  if (refs.length === 0) return;
  const allowed = new Set((await accessibleDatasets(actor)).map((d) => d.schemaName.toLowerCase()));
  allowed.add(ownSchema.toLowerCase());
  const denied = refs.filter((s) => !allowed.has(s));
  if (denied.length) {
    throw new ApiError(403, "SCHEMA_FORBIDDEN", `O SQL referencia schema(s) sem permissao de leitura: ${denied.join(", ")}`);
  }
}
