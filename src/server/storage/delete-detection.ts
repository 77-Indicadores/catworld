/**
 * Blocos de SQL/regras compartilhados (pg + mssql) da deteccao de exclusoes na origem. Puros (so montam texto).
 *
 * Ciclo de vida (ver docs/source-contract.md): a linha excluida na origem NAO e removida — fica marcada com
 * `cw_deleted_at` (soft delete). Leitores nunca devem ve-la (Postgres: politica RLS `cw_hide_deleted`; export/OData:
 * filtro `cw_deleted_at IS NULL`); `rows?since=` a reporta em `removedKeys`. Quem marca:
 *  - reconciliacao (fullSnapshot): toda chave ausente da staging;
 *  - deteccao de exclusoes (`detectDeletions`): chave ausente da staging E ausente da lista de chaves da origem
 *    (e sincronizada antes de `keysBefore`, para nao tocar linhas carregadas depois do inicio da leitura das chaves).
 *    Chave presente na lista de chaves (mas fora do delta) e preservada e DESMARCADA.
 */

/** Proporcao maxima de linhas vivas que uma leitura de chaves pode marcar de uma vez. */
export const KEYS_CHECK_MAX_RATIO = 0.3;
/** Abaixo desse numero de linhas vivas a proporcao nao e avaliada (tabelas minusculas). */
export const KEYS_CHECK_RATIO_MIN_LIVE = 50;

export type Dialect = "pg" | "mssql";

/** Guarda de seguranca: candidatas a marcar / linhas vivas acima do limite (so avaliado com live >= MIN_LIVE). */
export function keysCheckExceeds(r: { candidates: number; live: number }, maxRatio: number = KEYS_CHECK_MAX_RATIO): boolean {
  if (r.candidates === 0) return false;
  if (r.live < KEYS_CHECK_RATIO_MIN_LIVE) return false;
  return r.candidates / r.live > maxRatio;
}

/** Ausente da staging (linha do target sem correspondente na staging). */
export function absentFromStaging(qStg: string, key: string): string {
  return `NOT EXISTS (SELECT 1 FROM ${qStg} s WHERE s.${key} = t.${key})`;
}

/** Predicado "linha candidata a marcar" da lista de chaves (contagem de guarda). */
export function missingKeysWhere(o: { q: (id: string) => string; qKeys: string; key: string; beforeParam: string }): string {
  const { q, qKeys, key, beforeParam } = o;
  return `t.${q("cw_synced_at")} < ${beforeParam} AND NOT EXISTS (SELECT 1 FROM ${qKeys} k WHERE k.${key} = t.${key})`;
}

/**
 * Expressoes de carimbo das linhas do target AUSENTES da staging, copiadas para a tabela mesclada, e o predicado
 * das que passam de vivas para marcadas neste swap (retorno `marked`).
 *  - fullSnapshot: ausente = excluida (marca se ainda viva; preserva o carimbo existente).
 *  - keys (qKeys + beforeParam): chave na lista => desmarca; fora da lista e sincronizada antes de `before` =>
 *    marca (COALESCE preserva carimbo existente); sincronizada depois => intocada.
 *  - nenhum dos dois (delta parcial): copia como esta.
 * `cw_synced_at` e atualizado quando o estado muda (marca/desmarca) para o consumidor de `since` enxergar.
 */
/** Juncao das chaves distintas da origem (alias `k`) — ver `keysAsJoin` em carryPlan. */
export function keysJoinSql(qKeys: string, key: string): string {
  return `LEFT JOIN (SELECT DISTINCT ${key} FROM ${qKeys}) k ON k.${key} = t.${key}`;
}

export interface CarryPlan {
  syncedAtExpr: string;
  deletedAtExpr: string;
  markedWhere: string | null;
  /** So no modo `keysAsJoin`: clausula a colocar logo apos `FROM <target> t` em toda consulta que use as expressoes acima. */
  keysJoin?: string;
}

export function carryPlan(o: {
  q: (id: string) => string; qStg: string; key: string; qSyncedAt: string; qDeletedAt: string; now: string;
  fullSnapshot: boolean; qKeys?: string | null; beforeParam?: string;
  /**
   * true: "chave na lista" vira `k.chave IS NOT NULL` sobre um LEFT JOIN das chaves distintas (`keysJoin`), em vez de
   * um `EXISTS (SELECT ...)` correlacionado. O EXISTS dentro de CASE/FILTER vira um SubPlan avaliado POR LINHA (o
   * planner nao consegue transformar em anti-join): com ~800 mil linhas x ~800 mil chaves sem indice passa de 10 min
   * e estoura o statement_timeout do storage. O join e uma unica passada (hash join). O DISTINCT mantem a semantica do
   * EXISTS mesmo se a lista de chaves tiver repeticoes (sem multiplicar linhas do target).
   */
  keysAsJoin?: boolean;
}): CarryPlan {
  const { qStg, key, qSyncedAt, qDeletedAt, now } = o;
  const ts = `t.${qSyncedAt}`;
  const td = `t.${qDeletedAt}`;
  const absent = absentFromStaging(qStg, key);
  if (o.fullSnapshot) {
    return {
      syncedAtExpr: `CASE WHEN ${td} IS NULL THEN ${now} ELSE ${ts} END`,
      deletedAtExpr: `CASE WHEN ${td} IS NULL THEN ${now} ELSE ${td} END`,
      markedWhere: `${absent} AND ${td} IS NULL`,
    };
  }
  if (o.qKeys && o.beforeParam) {
    const asJoin = !!o.keysAsJoin;
    const inKeys = asJoin ? `k.${key} IS NOT NULL` : `EXISTS (SELECT 1 FROM ${o.qKeys} k WHERE k.${key} = t.${key})`;
    const notInKeys = asJoin ? `k.${key} IS NULL` : `NOT ${inKeys}`;
    const newly = `${td} IS NULL AND ${ts} < ${o.beforeParam} AND ${notInKeys}`;
    return {
      syncedAtExpr: `CASE WHEN ${inKeys} THEN (CASE WHEN ${td} IS NOT NULL THEN ${now} ELSE ${ts} END) WHEN ${newly} THEN ${now} ELSE ${ts} END`,
      deletedAtExpr: `CASE WHEN ${inKeys} THEN NULL WHEN ${ts} < ${o.beforeParam} THEN COALESCE(${td}, ${now}) ELSE ${td} END`,
      markedWhere: `${absent} AND ${newly}`,
      ...(asJoin ? { keysJoin: keysJoinSql(o.qKeys, key) } : {}),
    };
  }
  return { syncedAtExpr: ts, deletedAtExpr: td, markedWhere: null };
}
