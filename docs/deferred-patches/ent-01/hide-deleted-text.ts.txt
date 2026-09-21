/**
 * ENT-01 — 2a barreira do filtro de excluidas: reescrita por TOKENS, independente do parser de AST.
 *
 * O `hideDeletedRows` (AST) nao le todo o T-SQL que o contrato aceita (TRY_CAST, EXCEPT, ROLLUP, `t.*`, ...): nesses casos
 * ele devolve o SQL original e o filtro `cw_deleted_at IS NULL` some (falha ABERTA). Este modulo faz a mesma troca
 *
 *     FROM ds.vendas v  ->  FROM (SELECT * FROM ds.vendas WHERE cw_deleted_at IS NULL) AS v
 *
 * varrendo tokens (identificadores, [colchetes], "aspas", 'literais', comentarios, parenteses), sem gramatica completa.
 * Se nem assim da para ter certeza (dica de tabela, tabela-funcao...) E a consulta referencia uma tabela que TEM a
 * coluna, `guardDeleted` recusa a consulta (FALHA FECHADA) em vez de entregar linhas excluidas.
 */
import { CW_DELETED_AT } from "@/server/storage/connection";

export type TableState = "deleted" | "plain" | "missing";
export interface TextCtx {
  schemas: string[];
  lookup(schema: string, table: string): Promise<TableState>;
}

type Tok = { k: "id" | "q" | "str" | "num" | "p"; v: string; s: number; e: number };

function tokenize(sql: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === "-" && sql[i + 1] === "-") { while (i < n && sql[i] !== "\n") i++; continue; }
    if (c === "/" && sql[i + 1] === "*") { const e = sql.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
    const s = i;
    if (c === "'" || ((c === "N" || c === "n") && sql[i + 1] === "'")) {
      i += c === "'" ? 1 : 2;
      while (i < n) { if (sql[i] === "'") { if (sql[i + 1] === "'") { i += 2; continue; } i++; break; } i++; }
      out.push({ k: "str", v: sql.slice(s, i), s, e: i }); continue;
    }
    if (c === "[") { i++; while (i < n) { if (sql[i] === "]") { if (sql[i + 1] === "]") { i += 2; continue; } i++; break; } i++; } out.push({ k: "q", v: sql.slice(s, i), s, e: i }); continue; }
    if (c === '"') { i++; while (i < n) { if (sql[i] === '"') { if (sql[i + 1] === '"') { i += 2; continue; } i++; break; } i++; } out.push({ k: "q", v: sql.slice(s, i), s, e: i }); continue; }
    const id = /^[#@]{0,2}[A-Za-z_À-￿][\w$#@À-￿]*/.exec(sql.slice(i, i + 200));
    if (id) { i += id[0].length; out.push({ k: "id", v: id[0], s, e: i }); continue; }
    const num = /^\d[\d.]*(?:[eE][+-]?\d+)?/.exec(sql.slice(i, i + 40));
    if (num) { i += num[0].length; out.push({ k: "num", v: num[0], s, e: i }); continue; }
    i++;
    out.push({ k: "p", v: c, s, e: i });
  }
  return out;
}

const up = (t: Tok | undefined) => (t && t.k === "id" ? t.v.toUpperCase() : "");
const isP = (t: Tok | undefined, ch: string) => !!t && t.k === "p" && t.v === ch;
const nameOf = (t: Tok): string => (t.k === "q" ? (t.v[0] === "[" ? t.v.slice(1, -1).replace(/]]/g, "]") : t.v.slice(1, -1).replace(/""/g, '"')) : t.v);

/** Palavras que encerram a lista de tabelas do FROM (a virgula seguinte nao e "comma join"). */
const END_FROM = new Set(["WHERE", "GROUP", "HAVING", "ORDER", "UNION", "EXCEPT", "INTERSECT", "WINDOW", "LIMIT", "OFFSET", "FETCH", "FOR", "OPTION", "INTO", "SELECT"]);
/** Palavras que nunca sao alias. */
const NOT_ALIAS = new Set(["ON", "WHERE", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "OUTER", "JOIN", "GROUP", "ORDER", "HAVING", "UNION", "EXCEPT", "INTERSECT", "WITH", "USING", "NATURAL", "APPLY", "TABLESAMPLE", "PIVOT", "UNPIVOT", "FOR", "OFFSET", "FETCH", "LIMIT", "OPTION", "SET", "WINDOW"]);
const FROM_IN_FN = new Set(["TRIM", "EXTRACT", "SUBSTRING", "OVERLAY", "POSITION"]);

interface Ref { start: number; end: number; parts: Tok[]; alias: Tok | null; aliasKw: boolean }

export interface TextResult { ok: boolean; sql: string; rewritten: number; reason?: string }

/** Coleta as referencias a tabelas base em FROM/JOIN/virgula (todas as profundidades). */
function collectRefs(toks: Tok[], src: string): { refs: Ref[]; unsure: string | null } {
  const refs: Ref[] = [];
  let unsure: string | null = null;
  const ctes = new Set<string>();
  for (let i = 0; i < toks.length; i++) {
    // WITH nome [(cols)] AS (   e   , nome [(cols)] AS (
    if ((up(toks[i]) === "WITH" || isP(toks[i], ",")) && (toks[i + 1]?.k === "id" || toks[i + 1]?.k === "q")) {
      let j = i + 2;
      if (isP(toks[j], "(")) { let d = 0; for (; j < toks.length; j++) { if (isP(toks[j], "(")) d++; else if (isP(toks[j], ")") && --d === 0) { j++; break; } } }
      if (up(toks[j]) === "AS" && isP(toks[j + 1], "(")) ctes.add(nameOf(toks[i + 1]!).toLowerCase());
    }
  }
  const stack: { from: boolean; fnFrom: boolean }[] = [{ from: false, fnFrom: false }];
  const top = () => stack[stack.length - 1]!;
  const parseRef = (j: number): number => {
    const t = toks[j];
    if (!t || (t.k !== "id" && t.k !== "q")) return j - 1; // '(' subconsulta / VALUES / lixo: o laco principal segue dentro dos parenteses
    const parts: Tok[] = [t];
    let k = j + 1;
    while (isP(toks[k], ".") && (toks[k + 1]?.k === "id" || toks[k + 1]?.k === "q")) { parts.push(toks[k + 1]!); k += 2; }
    if (isP(toks[k], "(")) return k - 1; // tabela-funcao: nao e tabela base
    const first = parts[0]!;
    if (first.k === "id" && (first.v.startsWith("#") || first.v.startsWith("@"))) return k - 1;
    if (parts.length >= 3) return k - 1; // db.schema.tabela: outro banco (como o AST: nao mexe)
    if (parts.length === 1 && ctes.has(nameOf(first).toLowerCase())) return k - 1;
    let alias: Tok | null = null;
    let aliasKw = false;
    let a = k;
    if (up(toks[a]) === "AS") { aliasKw = true; a++; }
    const at = toks[a];
    if (at && (at.k === "q" || (at.k === "id" && !NOT_ALIAS.has(at.v.toUpperCase())))) { alias = at; a++; } else if (aliasKw) { unsure ??= "AS sem alias"; a = k; }
    if (up(toks[a]) === "WITH" && isP(toks[a + 1], "(")) unsure ??= "dica de tabela (WITH (...))";
    if (up(toks[a]) === "TABLESAMPLE" || up(toks[a]) === "FOR") unsure ??= "TABLESAMPLE/FOR SYSTEM_TIME";
    refs.push({ start: first.s, end: alias ? alias.e : parts[parts.length - 1]!.e, parts, alias, aliasKw });
    return alias ? a - 1 : k - 1;
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (isP(t, "(")) { stack.push({ from: false, fnFrom: FROM_IN_FN.has(up(toks[i - 1])) }); continue; }
    if (isP(t, ")")) { if (stack.length > 1) stack.pop(); continue; }
    if (t.k !== "id") { if (isP(t, ",") && top().from) i = parseRef(i + 1); continue; }
    const w = t.v.toUpperCase();
    if (w === "FROM") { if (top().fnFrom) continue; top().from = true; i = parseRef(i + 1); }
    else if (w === "JOIN") { top().from = true; i = parseRef(i + 1); }
    else if (END_FROM.has(w)) top().from = false;
  }
  if (stack.length !== 1) unsure ??= "parenteses desbalanceados";
  void src;
  return { refs, unsure };
}

const variants = (v: string, exact: boolean) => (exact ? [v] : [...new Set([v.toLowerCase(), v])]);

async function resolve(ctx: TextCtx, ref: Ref): Promise<{ schema: string; table: string; hit: boolean } | null> {
  const tbl = ref.parts[ref.parts.length - 1]!;
  const probe = async (schema: string, sExact: boolean) => {
    for (const s of variants(schema, sExact)) for (const t of variants(nameOf(tbl), tbl.k === "q")) {
      const st = await ctx.lookup(s, t);
      if (st !== "missing") return { schema: s, table: t, hit: st === "deleted" };
    }
    return null;
  };
  if (ref.parts.length === 2) return probe(nameOf(ref.parts[0]!), ref.parts[0]!.k === "q");
  const hits = [];
  for (const s of ctx.schemas) { const r = await probe(s, true); if (r) hits.push(r); }
  return hits.length === 1 ? hits[0]! : null;
}

/**
 * Reescreve por tokens. `ok=false` so quando a consulta referencia tabela COM `cw_deleted_at` e nao foi possivel garantir
 * o filtro (o chamador recusa a consulta). Sem tabela protegida referenciada: `ok=true`, SQL intacto.
 */
export async function hideDeletedByTokens(input: string, ctx: TextCtx): Promise<TextResult> {
  const toks = tokenize(input);
  const { refs, unsure } = collectRefs(toks, input);
  const targets: { ref: Ref; hit: boolean }[] = [];
  const memo = new Map<string, Promise<{ hit: boolean } | null>>();
  for (const ref of refs) {
    const key = ref.parts.map((p) => `${p.k}:${p.v}`).join(".");
    let p = memo.get(key);
    if (!p) { p = resolve(ctx, ref); memo.set(key, p); }
    const r = await p;
    if (r?.hit) targets.push({ ref, hit: true });
  }
  if (targets.length === 0) return { ok: true, sql: input, rewritten: 0 };
  if (unsure) return { ok: false, sql: input, rewritten: 0, reason: unsure };

  const edits: { s: number; e: number; text: string }[] = [];
  const unaliased: { schema: string; table: string }[] = [];
  for (const { ref } of targets) {
    const last = ref.parts[ref.parts.length - 1]!;
    const nameSpan = input.slice(ref.parts[0]!.s, last.e);
    const aliasText = ref.alias ? input.slice(ref.alias.s, ref.alias.e) : input.slice(last.s, last.e);
    if (!ref.alias && ref.parts.length === 2) unaliased.push({ schema: nameOf(ref.parts[0]!).toLowerCase(), table: nameOf(last).toLowerCase() });
    edits.push({ s: ref.start, e: ref.end, text: `(SELECT * FROM ${nameSpan} WHERE ${CW_DELETED_AT} IS NULL) AS ${aliasText}` });
  }
  // `schema.tabela.coluna` sem alias: com a tabela virando derivada o prefixo do schema deixa de existir
  if (unaliased.length) {
    const inRef = (pos: number) => targets.some(({ ref }) => pos >= ref.start && pos < ref.end);
    for (let i = 0; i + 4 < toks.length; i++) {
      const [a, d1, b, d2, c] = [toks[i]!, toks[i + 1]!, toks[i + 2]!, toks[i + 3]!, toks[i + 4]!];
      if ((a.k === "id" || a.k === "q") && isP(d1, ".") && (b.k === "id" || b.k === "q") && isP(d2, ".") && (c.k === "id" || c.k === "q" || isP(c, "*")) && !inRef(a.s) &&
          unaliased.some((u) => u.schema === nameOf(a).toLowerCase() && u.table === nameOf(b).toLowerCase())) edits.push({ s: a.s, e: b.s, text: "" });
    }
  }
  let out = input;
  for (const ed of edits.sort((x, y) => y.s - x.s)) out = out.slice(0, ed.s) + ed.text + out.slice(ed.e);
  return { ok: true, sql: out, rewritten: targets.length };
}
