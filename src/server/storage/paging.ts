/**
 * Paginacao deterministica (ENT-03).
 *
 * OFFSET sobre uma ordenacao NAO unica e nao deterministico: o Postgres pode devolver linhas empatadas em ordem
 * diferente a cada execucao, entao a pagina 2 repete linhas da 1 e perde outras (medido: ~10% em 300k linhas).
 * Solucao sem estado: quando a consulta e paginada (offset > 0, ou a 1a pagina truncou), acrescentamos ao ORDER BY
 * do nivel de topo a ordem por TODAS as colunas de saida (por ordinal). Linhas identicas em todas as colunas sao
 * intercambiaveis, entao a uniao das paginas passa a ser exatamente o conjunto (multiconjunto) da consulta.
 */

/** OIDs sem operador de ordenacao (json, xml, point, lseg, path, box, polygon, line, circle): ficam fora do desempate. */
const UNORDERABLE_OIDS = new Set([114, 142, 600, 601, 602, 603, 604, 628, 718]);

export interface TieBreakResult {
  /** SQL com o desempate aplicado (ou o original, se `applied` for false). */
  sql: string;
  applied: boolean;
  /** A consulta ja tinha ORDER BY no nivel de topo. */
  hadOrderBy: boolean;
  /** Ha colunas que nao podem entrar no desempate (json/xml/geometricos): empates so nelas seguem indeterminados. */
  skippedColumns: number;
}

interface Tail {
  orderByEnd: number; // posicao logo apos o ultimo ORDER BY de topo (-1 se nao ha)
  tailStart: number; // onde inserir o desempate: antes de LIMIT/OFFSET/FETCH/FOR de topo, ou no fim
}

/** Varre o SQL no nivel de topo (fora de parenteses, literais, identificadores e comentarios). */
function scanTopLevel(sql: string): Tail {
  let depth = 0;
  let lastOrderBy = -1;
  let tailStart = sql.length;
  let i = 0;
  const n = sql.length;
  const isWord = (c: string | undefined) => !!c && /[A-Za-z0-9_$]/.test(c);
  while (i < n) {
    const c = sql[i]!;
    if (c === "'") { i++; while (i < n) { if (sql[i] === "'") { if (sql[i + 1] === "'") { i += 2; continue; } break; } i++; } i++; continue; }
    if (c === '"') { i++; while (i < n) { if (sql[i] === '"') { if (sql[i + 1] === '"') { i += 2; continue; } break; } i++; } i++; continue; }
    if (c === "-" && sql[i + 1] === "-") { while (i < n && sql[i] !== "\n") i++; continue; }
    if (c === "/" && sql[i + 1] === "*") { const e = sql.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) { const e = sql.indexOf(m[0], i + m[0].length); i = e < 0 ? n : e + m[0].length; continue; }
    }
    if (c === "(") { depth++; i++; continue; }
    if (c === ")") { depth--; i++; continue; }
    if (depth === 0 && /[A-Za-z]/.test(c) && !isWord(sql[i - 1])) {
      const rest = sql.slice(i, i + 64);
      const ob = /^ORDER\s+BY\b/i.exec(rest);
      if (ob) { lastOrderBy = i + ob[0].length; tailStart = sql.length; i += ob[0].length; continue; }
      const kw = /^(LIMIT|OFFSET|FETCH|FOR)\b/i.exec(rest);
      if (kw && tailStart === sql.length) { tailStart = i; i += kw[0].length; continue; }
      // avanca a palavra inteira
      let j = i;
      while (j < n && isWord(sql[j])) j++;
      i = Math.max(j, i + 1);
      continue;
    }
    i++;
  }
  return { orderByEnd: lastOrderBy, tailStart };
}

/**
 * Acrescenta o desempate por todas as colunas de saida ao ORDER BY de topo (criando-o se nao houver).
 * `columnTypeOids` = dataTypeID de cada coluna de saida, na ordem.
 */
export function addTieBreaker(sql: string, columnTypeOids: number[]): TieBreakResult {
  const clean = sql.replace(/[\s;]+$/, "");
  const ordinals: number[] = [];
  columnTypeOids.forEach((oid, i) => { if (!UNORDERABLE_OIDS.has(oid)) ordinals.push(i + 1); });
  const skippedColumns = columnTypeOids.length - ordinals.length;
  const { orderByEnd, tailStart } = scanTopLevel(clean);
  const hadOrderBy = orderByEnd >= 0;
  if (ordinals.length === 0) return { sql, applied: false, hadOrderBy, skippedColumns };
  const head = clean.slice(0, tailStart).replace(/\s+$/, "");
  const tail = clean.slice(tailStart);
  const list = ordinals.join(", ");
  const withOrder = hadOrderBy ? `${head}, ${list}` : `${head} ORDER BY ${list}`;
  return { sql: tail ? `${withOrder} ${tail}` : withOrder, applied: true, hadOrderBy, skippedColumns };
}
