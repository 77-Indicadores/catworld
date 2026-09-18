/**
 * Traduz SQL no dialeto T-SQL (MSSQL) para PostgreSQL.
 * Cobre o subconjunto usado em queries analíticas/leitura.
 *
 * NÃO é um parser AST completo — usa transformações regex ordenadas
 * com proteção de literais de string para evitar falsos positivos.
 *
 * Para adicionar novos padrões: inclua uma nova etapa em `translateMssqlToPg`
 * ou em `REPLACERS`, e adicione um teste unitário correspondente.
 */

export interface TranslateResult {
  sql: string;
  /** Valor extraído de SELECT TOP N — deve ser usado como LIMIT final. */
  topLimit: number | null;
}

// ---------------------------------------------------------------------------
// Ponto de entrada
// ---------------------------------------------------------------------------

export function translateMssqlToPg(input: string): TranslateResult {
  let sql = input;
  let topLimit: number | null = null;

  // ① Remover WITH (NOLOCK) / WITH(NOLOCK)
  sql = outsideLiterals(sql, (s) =>
    s.replace(/\bWITH\s*\(\s*NOLOCK\s*\)/gi, ""),
  );

  // ② SELECT TOP N  →  SELECT  (guarda N para LIMIT mais tarde)
  sql = outsideLiterals(sql, (s) =>
    s.replace(/\bSELECT\s+TOP\s+\(?(\d+)\)?\s+/gi, (_, n) => {
      topLimit = parseInt(n, 10);
      return "SELECT ";
    }),
  );

  // ③ [identificador] → "identificador"
  sql = replaceBrackets(sql);

  // ④ Funções simples (ordem importa: antes de CONVERT/CAST genéricos)
  sql = outsideLiterals(sql, (s) =>
    s
      .replace(/\bISNULL\s*\(/gi, "COALESCE(")
      .replace(/\bLEN\s*\(/gi, "LENGTH(")
      .replace(/\bGET(?:UTC)?DATE\s*\(\s*\)/gi, "NOW()")
      .replace(/\bSYSDATETIME(?:OFFSET)?\s*\(\s*\)/gi, "NOW()")
      .replace(/\bNEWID\s*\(\s*\)/gi, "gen_random_uuid()")
      .replace(/\bCHECKSUM_AGG\s*\(/gi, "COUNT(DISTINCT ") // aproximação comum
      .replace(/\bROW_NUMBER\s*\(\s*\)/gi, "ROW_NUMBER()")   // mesmo em PG
  );

  // ⑤ CONVERT(tipo, expr[, estilo])  →  CAST(expr AS pgtype)
  sql = replaceConvert(sql);

  // ⑥ CAST(x AS tipo_mssql)  →  CAST(x AS tipo_pg)
  sql = replaceCastTypes(sql);

  // ⑦ DATEDIFF(part, start, end)
  sql = replaceDateDiff(sql);

  // ⑧ DATEADD(part, n, date)
  sql = replaceDateAdd(sql);

  // ⑨ CHARINDEX(needle, haystack[, start])  →  POSITION / STRPOS
  sql = replaceCharIndex(sql);

  // ⑩ STR(expr)  →  (expr)::TEXT
  sql = outsideLiterals(sql, (s) =>
    s.replace(/\bSTR\s*\(([^)]+)\)/gi, "($1)::TEXT"),
  );

  // ⑪ OFFSET N ROWS FETCH NEXT M ROWS ONLY  →  LIMIT M OFFSET N
  //    (PG suporta a sintaxe SQL padrão, mas normaliza por segurança)
  sql = outsideLiterals(sql, (s) =>
    s.replace(
      /\bOFFSET\s+(\d+)\s+ROWS?\s+FETCH\s+(?:NEXT|FIRST)\s+(\d+)\s+ROWS?\s+ONLY\b/gi,
      "LIMIT $2 OFFSET $1",
    ),
  );

  return { sql: sql.trim(), topLimit };
}

// ---------------------------------------------------------------------------
// Mapeamento de tipos MSSQL → PG
// ---------------------------------------------------------------------------

function mssqlTypeToPg(mssqlType: string): string {
  const t = mssqlType.trim().toUpperCase();
  if (/^N?VAR(?:CHAR|BINARY)/.test(t) || t === "TEXT" || t === "NTEXT") return "TEXT";
  if (t === "INT" || t === "INTEGER") return "INTEGER";
  if (t === "BIGINT") return "BIGINT";
  if (t === "SMALLINT") return "SMALLINT";
  if (t === "TINYINT") return "SMALLINT";
  if (t === "BIT") return "BOOLEAN";
  if (t === "FLOAT" || t === "REAL") return "DOUBLE PRECISION";
  if (/^DECIMAL|^NUMERIC/.test(t)) return mssqlType.trim(); // mantém precisão
  if (t === "MONEY" || t === "SMALLMONEY") return "DECIMAL(19,4)";
  if (t === "DATETIME" || t === "DATETIME2" || t === "SMALLDATETIME") return "TIMESTAMP";
  if (t === "DATE") return "DATE";
  if (t === "TIME") return "TIME";
  if (t === "DATETIMEOFFSET") return "TIMESTAMPTZ";
  if (t === "UNIQUEIDENTIFIER") return "UUID";
  if (t === "VARBINARY" || t === "BINARY" || t === "IMAGE") return "BYTEA";
  if (t === "XML") return "TEXT";
  if (t === "SQL_VARIANT") return "TEXT";
  return mssqlType.trim(); // desconhecido — passa como está
}

// ---------------------------------------------------------------------------
// CONVERT(tipo, expr[, estilo])
// ---------------------------------------------------------------------------

function replaceConvert(sql: string): string {
  // Procura CONVERT( e navega com contagem de parênteses para extrair args
  const result: string[] = [];
  let i = 0;
  while (i < sql.length) {
    // Proteção de literais
    if (sql[i] === "'" || (sql[i] === "N" && sql[i + 1] === "'")) {
      const start = i;
      if (sql[i] === "N") i++;
      i++; // abre '
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      result.push(sql.slice(start, i));
      continue;
    }

    const match = /^CONVERT\s*\(/i.exec(sql.slice(i));
    if (!match) {
      result.push(sql[i]!);
      i++;
      continue;
    }

    // Encontrou CONVERT(
    i += match[0].length;
    const args = extractArgs(sql, i);
    if (!args) {
      result.push(match[0]);
      continue;
    }
    i = args.end + 1; // salta até depois do ')'

    const [typeArg, valueArg] = args.parts;
    if (!typeArg || !valueArg) {
      result.push(`CONVERT(${args.raw})`);
      continue;
    }

    const pgType = mssqlTypeToPg(typeArg.trim());
    result.push(`CAST(${valueArg.trim()} AS ${pgType})`);
  }
  return result.join("");
}

// ---------------------------------------------------------------------------
// CAST(x AS tipo_mssql) → CAST(x AS tipo_pg)
// ---------------------------------------------------------------------------

function replaceCastTypes(sql: string): string {
  return outsideLiterals(sql, (s) =>
    s.replace(/\bCAST\s*\((.+?)\s+AS\s+((?:N?VAR(?:CHAR|BINARY)|NTEXT|TEXT|INT(?:EGER)?|BIGINT|SMALLINT|TINYINT|BIT|FLOAT|REAL|DECIMAL|NUMERIC|MONEY|SMALLMONEY|DATETIME2?|SMALLDATETIME|DATE(?!TIME)|TIME|DATETIMEOFFSET|UNIQUEIDENTIFIER|VARBINARY|IMAGE|XML|SQL_VARIANT)(?:\s*\([^)]*\))?)\s*\)/gi,
      (_, expr, mssqlType) => `CAST(${expr} AS ${mssqlTypeToPg(mssqlType)})`,
    ),
  );
}

// ---------------------------------------------------------------------------
// DATEDIFF
// ---------------------------------------------------------------------------

const DATEDIFF_PART: Record<string, string> = {
  year: "year", yy: "year", yyyy: "year",
  quarter: "quarter", qq: "quarter", q: "quarter",
  month: "month", mm: "month", m: "month",
  dayofyear: "doy", dy: "doy", y: "doy",
  day: "day", dd: "day", d: "day",
  week: "week", wk: "week", ww: "week",
  hour: "hour", hh: "hour",
  minute: "minute", mi: "minute", n: "minute",
  second: "second", ss: "second", s: "second",
  millisecond: "millisecond", ms: "millisecond",
};

function replaceDateDiff(sql: string): string {
  const result: string[] = [];
  let i = 0;
  while (i < sql.length) {
    if (isInsideLiteral(sql, i)) { result.push(sql[i]!); i++; continue; }
    const match = /^DATEDIFF\s*\(/i.exec(sql.slice(i));
    if (!match) { result.push(sql[i]!); i++; continue; }
    i += match[0].length;
    const args = extractArgs(sql, i);
    if (!args || args.parts.length < 3) {
      result.push(match[0]);
      continue;
    }
    i = args.end + 1;
    const [part, start, end] = args.parts.map((p) => p.trim());
    const pgPart = DATEDIFF_PART[part!.toLowerCase().replace(/'/g, "")] ?? "day";
    // EXTRACT(epoch FROM (end - start)) / unit_seconds — simplificado como DATE_PART
    result.push(
      `FLOOR(EXTRACT(EPOCH FROM (${end} - ${start})) / ${epochDivisor(pgPart)})::BIGINT`,
    );
  }
  return result.join("");
}

function epochDivisor(part: string): number {
  const map: Record<string, number> = {
    year: 31536000, quarter: 7776000, month: 2592000,
    week: 604800, day: 86400, hour: 3600,
    minute: 60, second: 1, millisecond: 0.001,
  };
  return map[part] ?? 86400;
}

// ---------------------------------------------------------------------------
// DATEADD
// ---------------------------------------------------------------------------

const DATEADD_PART: Record<string, string> = {
  year: "years", yy: "years", yyyy: "years",
  quarter: "months", qq: "months", q: "months",  // aproximação: 1 quarter = 3 meses
  month: "months", mm: "months", m: "months",
  day: "days", dd: "days", d: "days", dayofyear: "days", dy: "days", y: "days",
  week: "weeks", wk: "weeks", ww: "weeks",
  hour: "hours", hh: "hours",
  minute: "minutes", mi: "minutes", n: "minutes",
  second: "seconds", ss: "seconds", s: "seconds",
  millisecond: "milliseconds", ms: "milliseconds",
};

function replaceDateAdd(sql: string): string {
  const result: string[] = [];
  let i = 0;
  while (i < sql.length) {
    if (isInsideLiteral(sql, i)) { result.push(sql[i]!); i++; continue; }
    const match = /^DATEADD\s*\(/i.exec(sql.slice(i));
    if (!match) { result.push(sql[i]!); i++; continue; }
    i += match[0].length;
    const args = extractArgs(sql, i);
    if (!args || args.parts.length < 3) {
      result.push(match[0]);
      continue;
    }
    i = args.end + 1;
    const [part, n, date] = args.parts.map((p) => p.trim());
    const pgPart = DATEADD_PART[part!.toLowerCase().replace(/'/g, "")] ?? "days";
    const multiplier = pgPart === "months" && part!.toLowerCase().replace(/'/g, "") === "quarter" ? `(${n}) * 3` : n!;
    result.push(`(${date} + (${multiplier} || ' ${pgPart}')::INTERVAL)`);
  }
  return result.join("");
}

// ---------------------------------------------------------------------------
// CHARINDEX(needle, haystack[, start]) → POSITION / STRPOS
// ---------------------------------------------------------------------------

function replaceCharIndex(sql: string): string {
  const result: string[] = [];
  let i = 0;
  while (i < sql.length) {
    if (isInsideLiteral(sql, i)) { result.push(sql[i]!); i++; continue; }
    const match = /^CHARINDEX\s*\(/i.exec(sql.slice(i));
    if (!match) { result.push(sql[i]!); i++; continue; }
    i += match[0].length;
    const args = extractArgs(sql, i);
    if (!args || args.parts.length < 2) {
      result.push(match[0]);
      continue;
    }
    i = args.end + 1;
    const [needle, haystack] = args.parts.map((p) => p.trim());
    // Ignora o argumento start (não tem equivalente direto simples em PG)
    result.push(`POSITION(${needle} IN ${haystack})`);
  }
  return result.join("");
}

// ---------------------------------------------------------------------------
// [bracket] → "quoted"
// ---------------------------------------------------------------------------

function replaceBrackets(sql: string): string {
  return outsideLiterals(sql, (s) =>
    s.replace(/\[([^\]]+)\]/g, (_, name: string) =>
      `"${name.replace(/"/g, '""')}"`,
    ),
  );
}

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------

/**
 * Aplica `fn` apenas fora de literais de string SQL ('' e N'...' com escapes).
 * Divide o SQL em segmentos alternando literal/não-literal, aplica `fn` nos
 * segmentos não-literais e reune.
 */
function outsideLiterals(sql: string, fn: (s: string) => string): string {
  // Divide em partes: [fora, dentro, fora, dentro, ...]
  const parts: string[] = [];
  let i = 0;
  let last = 0;
  while (i < sql.length) {
    const isN = sql[i] === "N" && sql[i + 1] === "'";
    if (isN || sql[i] === "'") {
      parts.push(sql.slice(last, i)); // fora — aplica fn
      const start = i;
      if (isN) i++;
      i++; // abre '
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      parts.push(sql.slice(start, i)); // dentro — preserva
      last = i;
    } else {
      i++;
    }
  }
  parts.push(sql.slice(last));
  return parts.map((p, idx) => (idx % 2 === 0 ? fn(p) : p)).join("");
}

/**
 * Verifica se o índice `i` está dentro de um literal de string (heurística simples).
 * Usada nos loops char-a-char de DATEDIFF/DATEADD/CHARINDEX.
 */
function isInsideLiteral(sql: string, pos: number): boolean {
  let count = 0;
  for (let i = 0; i < pos; i++) {
    if ((sql[i] === "N" && sql[i + 1] === "'") || sql[i] === "'") {
      if (sql[i] === "N") i++;
      i++;
      while (i < pos) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { count++; break; }
        i++;
      }
      if (i >= pos) return true; // ainda dentro do literal
    }
  }
  return count % 2 === 1;
}

/**
 * A partir de `start` (logo após o '(' de abertura), extrai os argumentos
 * de nível superior separados por vírgula, respeitando parênteses aninhados.
 * Retorna { parts, raw, end } onde `end` é o índice do ')' de fechamento.
 */
function extractArgs(sql: string, start: number): { parts: string[]; raw: string; end: number } | null {
  let depth = 1;
  let i = start;
  const raw_start = start;
  const breakpoints: number[] = [start];

  while (i < sql.length && depth > 0) {
    const c = sql[i];
    if (c === "'" || (c === "N" && sql[i + 1] === "'")) {
      if (c === "N") i++;
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) break;
    } else if (c === "," && depth === 1) {
      breakpoints.push(i + 1);
    }
    i++;
  }

  if (depth !== 0) return null;

  breakpoints.push(i);
  const parts: string[] = [];
  for (let k = 0; k < breakpoints.length - 1; k++) {
    parts.push(sql.slice(breakpoints[k]!, breakpoints[k + 1]! - (k < breakpoints.length - 2 ? 1 : 0)).trim());
  }

  return { parts, raw: sql.slice(raw_start, i), end: i };
}
