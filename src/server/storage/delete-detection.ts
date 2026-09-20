/**
 * Blocos de SQL compartilhados (pg + mssql) da deteccao de exclusoes na origem. Puros (so montam texto), para
 * poderem ser testados sem banco.
 *
 * Ciclo de vida (ver docs/source-contract.md): a linha excluida na origem e REMOVIDA FISICAMENTE da tabela e a
 * chave dela vai para uma tabela lateral `cw_tomb_<tabela>` (lapide) no mesmo schema, na MESMA transacao/instrucao
 * da remocao. Quem detecta:
 *  - reconciliacao (fullSnapshot): toda chave ausente da staging;
 *  - escopo (`scopeColumns`): chave ausente da staging cuja tupla de escopo EXISTE na staging (grupo relido);
 *  - verificacao de chaves: chave ausente da lista de chaves da origem (e sincronizada antes de `before`).
 */
import { createHash } from "crypto";

/** Proporcao maxima de linhas que uma verificacao de chaves pode remover de uma vez. */
export const KEYS_CHECK_MAX_RATIO = 0.3;
/** Abaixo desse numero de linhas a proporcao nao e avaliada (tabelas minusculas); lista vazia sempre bloqueia. */
export const KEYS_CHECK_RATIO_MIN_LIVE = 50;
/** Validade padrao das lapides (dias); 0 = guardar para sempre. Configuravel: `retention.tombstone_days`. */
export const TOMBSTONE_TTL_DEFAULT_DAYS = 30;

export const TOMB_KEY = "cw_key";
export const TOMB_AT = "cw_deleted_at";

/** `cw_tomb_<tabela>` (interna; nunca entra no catalogo). Nome longo e encurtado com hash (limite de 63 do Postgres). */
export function tombstoneTableName(table: string): string {
  const name = `cw_tomb_${table}`;
  if (name.length <= 63) return name;
  return `${name.slice(0, 50)}_${createHash("md5").update(table).digest("hex").slice(0, 8)}`;
}

export type Dialect = "pg" | "mssql";

export type MarkMissingKeysOpts = { maxRatio?: number };
export type MarkMissingKeysResult = {
  /** Linhas efetivamente removidas (0 se abortou). */
  marked: number;
  /** Linhas candidatas (ausentes da lista de chaves e sincronizadas antes de `before`). */
  candidates: number;
  /** Linhas da tabela. */
  live: number;
  /** true quando candidatas/linhas passou de maxRatio: nada foi removido. */
  aborted: boolean;
};

export type ScopeJoin = { join: string; hit: string; miss: string };

/**
 * LEFT JOIN nas tuplas de escopo distintas da staging (todas as colunas nao nulas). Join por igualdade nunca casa
 * NULL no target; `hit` e verdadeiro so quando a tupla existe na staging. Um JOIN (hash) em vez de EXISTS
 * correlacionado evita O(target x staging).
 */
export function scopeJoin(q: (id: string) => string, scopeColumns: string[], qStg: string): ScopeJoin {
  const list = scopeColumns.map(q).join(", ");
  const notNull = scopeColumns.map(c => `${q(c)} IS NOT NULL`).join(" AND ");
  const on = scopeColumns.map(c => `sc.${q(c)} = t.${q(c)}`).join(" AND ");
  return {
    join: `LEFT JOIN (SELECT DISTINCT ${list} FROM ${qStg} WHERE ${notNull}) sc ON ${on}`,
    hit: `sc.${q(scopeColumns[0]!)} IS NOT NULL`,
    miss: `sc.${q(scopeColumns[0]!)} IS NULL`,
  };
}

/**
 * Plano do merge: quais linhas do target ausentes da staging sao COPIADAS (preservadas) e quais viram lapide.
 * `active` = ha remocao neste merge (fullSnapshot ou escopo). Sem remocao, so `copyWhere` (ausentes) e usado.
 */
export function mergeRemovalPlan(o: {
  dialect: Dialect; q: (id: string) => string; qTgt: string; qStg: string; qTomb: string; key: string;
  qDeletedAt: string; now: string; fullSnapshot: boolean; scopeColumns: string[] | null;
}) {
  const { q, qTgt, qStg, qTomb, key, qDeletedAt, now } = o;
  const scope = !o.fullSnapshot && o.scopeColumns?.length ? scopeJoin(q, o.scopeColumns, qStg) : null;
  const active = o.fullSnapshot || !!scope;
  const absent = `NOT EXISTS (SELECT 1 FROM ${qStg} s WHERE s.${key} = t.${key})`;
  // Copia (preserva) as ausentes que NAO foram removidas; fullSnapshot nao preserva nenhuma.
  const copyJoin = scope?.join ?? "";
  const copyWhere = !active ? absent : o.fullSnapshot ? `${absent} AND 1 = 0` : `${absent} AND ${scope!.miss}`;
  const removeWhere = o.fullSnapshot ? absent : `${absent} AND ${scope?.hit ?? "1 = 0"}`;
  const tk = q(TOMB_KEY);
  const ta = q(TOMB_AT);
  // Revive: chave que voltou na staging perde a lapide.
  const revive = o.dialect === "pg"
    ? `DELETE FROM ${qTomb} k WHERE EXISTS (SELECT 1 FROM ${qStg} s WHERE s.${key} = k.${tk})`
    : `DELETE k FROM ${qTomb} k WHERE EXISTS (SELECT 1 FROM ${qStg} s WHERE s.${key} = k.${tk})`;
  // Lapide das removidas (preserva o carimbo de exclusao legado se a linha ja tinha um; sem duplicar).
  const insert = `INSERT INTO ${qTomb} (${tk}, ${ta}) SELECT t.${key}, COALESCE(t.${qDeletedAt}, ${now}) FROM ${qTgt} t ${copyJoin} WHERE ${removeWhere} AND NOT EXISTS (SELECT 1 FROM ${qTomb} k WHERE k.${tk} = t.${key})`;
  return { active, copyJoin, copyWhere, revive, insert };
}

/** Predicado das linhas a remover na verificacao de chaves (guarda `cw_synced_at < before` contra corrida). */
export function missingKeysWhere(o: { q: (id: string) => string; qKeys: string; key: string; beforeParam: string }): string {
  const { q, qKeys, key, beforeParam } = o;
  return `t.${q("cw_synced_at")} < ${beforeParam} AND NOT EXISTS (SELECT 1 FROM ${qKeys} k WHERE k.${key} = t.${key})`;
}

/** DELETE + lapide na MESMA instrucao (pg: CTE com RETURNING; mssql: OUTPUT ... INTO). */
export function deleteMissingKeysSql(o: { dialect: Dialect; q: (id: string) => string; qTgt: string; qTomb: string; key: string; where: string }): string {
  const tk = o.q(TOMB_KEY);
  const ta = o.q(TOMB_AT);
  return o.dialect === "pg"
    ? `WITH del AS (DELETE FROM ${o.qTgt} t WHERE ${o.where} RETURNING t.${o.key} AS k) INSERT INTO ${o.qTomb} (${tk}, ${ta}) SELECT k, now() FROM del`
    : `DELETE t OUTPUT DELETED.${o.key}, SYSUTCDATETIME() INTO ${o.qTomb} (${tk}, ${ta}) FROM ${o.qTgt} t WHERE ${o.where} OPTION (MAXDOP 1)`;
}

export function keysCheckExceeds(r: { candidates: number; live: number }, maxRatio: number): boolean {
  if (r.candidates === 0) return false;
  if (r.live < KEYS_CHECK_RATIO_MIN_LIVE) return false;
  return r.candidates / r.live > maxRatio;
}
