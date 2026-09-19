/**
 * Leitura barata da FORMA de uma consulta T-SQL (sem parser): usada so para AVISOS ao cliente
 * (paginacao sem ORDER BY, TOP acima do limite). Nunca decide o que executa.
 */

/** Troca literais, comentarios e identificadores delimitados por espacos (mantem posicoes e parenteses). */
export function maskLiterals(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    const n = sql[i + 1];
    if (c === "'" ) { // literal '...' com '' de escape
      out += " "; i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { out += "  "; i += 2; continue; }
        if (sql[i] === "'") { out += " "; i++; break; }
        out += sql[i] === "\n" ? "\n" : " "; i++;
      }
    } else if (c === "-" && n === "-") {
      while (i < sql.length && sql[i] !== "\n") { out += " "; i++; }
    } else if (c === "/" && n === "*") {
      out += "  "; i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) { out += sql[i] === "\n" ? "\n" : " "; i++; }
      if (i < sql.length) { out += "  "; i += 2; }
    } else if (c === '"' || c === "[") {
      const close = c === '"' ? '"' : "]";
      out += " "; i++;
      while (i < sql.length && sql[i] !== close) { out += " "; i++; }
      if (i < sql.length) { out += " "; i++; }
    } else { out += c; i++; }
  }
  return out;
}

/** ORDER BY no nivel de fora (o de dentro de subconsulta ou de OVER (...) nao conta). */
export function hasTopLevelOrderBy(sql: string): boolean {
  const s = maskLiterals(sql);
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && (i === 0 || /\W/.test(s[i - 1]!)) && /^ORDER\s+BY\b/i.test(s.slice(i, i + 12))) return true;
  }
  return false;
}

/** N do primeiro `SELECT [DISTINCT] TOP [(]N[)]` da consulta, ou null. */
export function firstTopN(sql: string): number | null {
  const m = /\bSELECT\s+(?:DISTINCT\s+)?TOP\s*\(?\s*(\d+)\s*\)?/i.exec(maskLiterals(sql));
  return m ? Number(m[1]) : null;
}

/** Avisos de FORMA para a resposta de uma consulta paginada (meta.warnings). */
export function paginationWarnings(sql: string, limit: number, offset: number): string[] {
  const w: string[] = [];
  if (offset > 0 && !hasTopLevelOrderBy(sql)) {
    w.push("paginacao com offset sem ORDER BY: a ordem nao e garantida entre paginas (linhas podem se repetir ou faltar); adicione ORDER BY ou use \"stream\": true");
  }
  const top = firstTopN(sql);
  if (top !== null && top > limit) {
    w.push(`TOP ${top} excede o limite por pagina (${limit}): o resultado vem paginado (truncated: true); use offset ou "stream": true`);
  }
  return w;
}
