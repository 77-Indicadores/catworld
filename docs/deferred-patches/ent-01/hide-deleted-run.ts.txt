/**
 * Liga o `hideDeletedRows` ao STORAGE: contexto com metadado cacheado (`listColumns` com TTL) e contador do contrato.
 * NAO usar em fonte LIVE (consulta direto na origem: nao ha colunas cw_*).
 *
 * Independe do modo do contrato (`sql_contract.mode`, inclusive `off`): o modo escolhe o TRADUTOR (regex antigo x AST),
 * enquanto este filtro e uma garantia de seguranca/consistencia dos dados e roda antes de qualquer traducao.
 *
 * ENT-01 (falha FECHADA): 1) AST; 2) se o parser nao le o SQL, reescrita por TOKENS; 3) se nem assim da para garantir o
 * filtro E a consulta referencia tabela com `cw_deleted_at`, a consulta e RECUSADA (400 DELETED_FILTER_UNVERIFIABLE).
 * Antes o passo 3 devolvia o SQL original e linhas excluidas vazavam para o dono da tabela (ADMIN / pg_isolation=off / SQL Server).
 */
import { CW_DELETED_AT, type StorageConnection } from "@/server/storage/connection";
import { validateReadOnlySql } from "@/server/security/sql-safety";
import { ApiError } from "@/server/http";
import { hideDeletedRows, type TableState } from "./hide-deleted";
import { hideDeletedByTokens } from "./hide-deleted-text";
import { logContractEvent } from "./apply";

const TTL_MS = 60_000;
const cache = new WeakMap<StorageConnection, Map<string, { at: number; state: TableState }>>();

/** Estado da tabela (com/sem cw_deleted_at, ou inexistente), cacheado por conexao por alguns segundos. */
export async function tableState(conn: StorageConnection, schema: string, table: string): Promise<TableState> {
  let per = cache.get(conn);
  if (!per) { per = new Map(); cache.set(conn, per); }
  const key = `${schema}.${table}`;
  const hit = per.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.state;
  const cols = await conn.listColumns(schema, table);
  const state: TableState = cols.length === 0 ? "missing" : cols.some((c) => c.name === CW_DELETED_AT) ? "deleted" : "plain";
  per.set(key, { at: Date.now(), state });
  return state;
}

export class DeletedFilterUnverifiable extends ApiError {
  constructor(reason: string) {
    super(
      400,
      "DELETED_FILTER_UNVERIFIABLE",
      `A consulta usa uma construcao que o Catworld nao consegue proteger para esconder linhas excluidas (${reason}). Reescreva usando FROM/JOIN simples, sem dicas de tabela nem tabelas-funcao.`,
    );
  }
}

/**
 * Devolve o SQL com as tabelas que tem `cw_deleted_at` filtradas. LANCA `DeletedFilterUnverifiable` (400) se a consulta
 * referencia uma dessas tabelas e o filtro nao pode ser garantido; consultas sem tabela protegida passam intactas.
 */
export async function hideDeletedForStorage(conn: StorageConnection, sql: string, schemas: string[], path: string): Promise<string> {
  const v = validateReadOnlySql(sql);
  if (!v.safe) return sql; // o executor recusa depois, com a mensagem de sempre
  const lookup = (s: string, t: string) => tableState(conn, s, t);

  let astReason: string | null = null;
  try {
    const r = await hideDeletedRows(v.statement, { schemas, lookup, onSkip: (reason) => { astReason = reason; } });
    if (astReason === null) return r.rewritten > 0 ? r.sql : sql;
  } catch (e) {
    astReason = e instanceof Error ? e.message : String(e);
  }
  logContractEvent("hide-deleted-skip", path, sql, `ast: ${astReason}`);

  // 2a barreira: tokens. Se a consulta de metadado falhar tambem, a consulta e recusada (falha fechada).
  try {
    const t = await hideDeletedByTokens(v.statement, { schemas, lookup });
    if (t.ok) {
      logContractEvent(t.rewritten > 0 ? "hide-deleted-tokens" : "hide-deleted-untouched", path, sql);
      return t.rewritten > 0 ? t.sql : sql;
    }
    logContractEvent("hide-deleted-reject", path, sql, t.reason);
    throw new DeletedFilterUnverifiable(t.reason ?? "construcao nao reconhecida");
  } catch (e) {
    if (e instanceof DeletedFilterUnverifiable) throw e;
    logContractEvent("hide-deleted-reject", path, sql, e instanceof Error ? e.message : String(e));
    throw new DeletedFilterUnverifiable("nao foi possivel consultar o catalogo de tabelas");
  }
}
