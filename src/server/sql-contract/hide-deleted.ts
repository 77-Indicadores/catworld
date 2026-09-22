/**
 * Esconde linhas excluidas na origem (soft delete: `cw_deleted_at` preenchido) de QUALQUER leitor SQL do storage.
 *
 * Por que aqui e nao so na RLS do Postgres: a RLS (`cw_hide_deleted`) nao vale para o dono da tabela (ADMIN, ou
 * `pg_isolation.mode = off`), nem para as tabelas derivadas (montadas com a conta dona) e nao existe no SQL Server.
 * Este modulo e o mecanismo uniforme: reescreve o SQL do usuario (T-SQL -> T-SQL, ANTES da traducao por dialeto),
 * trocando cada referencia a tabela do storage QUE TEM a coluna por uma tabela derivada filtrada:
 *
 *     FROM ds.vendas v      ->  FROM (SELECT * FROM ds.vendas WHERE cw_deleted_at IS NULL) AS v
 *     JOIN ds.vendas        ->  JOIN (SELECT * FROM ds.vendas WHERE cw_deleted_at IS NULL) AS vendas
 *
 * Regras:
 *  - So mexe em base tables de FROM/JOIN (inclusive subconsultas, corpos de CTE e ramos de UNION). Nome de CTE nunca e reescrito.
 *  - Sem schema (`FROM vendas`): resolve nos `ctx.schemas` do escopo; so reescreve se existir em exatamente UM schema.
 *  - Nome de 3 partes (`db.schema.tabela`), `#temp`, `@var`, funcoes de tabela e tabelas temporais: nao mexe.
 *  - Nenhuma tabela com a coluna referenciada: devolve o SQL ORIGINAL, byte a byte (nem re-emite).
 *  - SQL que o parser nao le (sintaxe Postgres, `TRY_CAST`, `schema.tabela.coluna`): NAO reescreve, chama `ctx.onSkip`
 *    (contador do contrato) e devolve o original — nunca derruba a consulta. Ai a unica barreira e a RLS (so Postgres/nao-dono).
 *  - Identificadores: os entre [colchetes]/"aspas" preservam a caixa; os sem delimitador voltam sem delimitador
 *    (o contrato T-SQL -> Postgres continua dobrando-os para minusculo como antes).
 */
import { Parser } from "node-sql-parser";
import { CW_DELETED_AT } from "@/server/storage/connection";
import { mapOutsideLiterals } from "./translate";

const parser = new Parser();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

export type TableState = "deleted" | "plain" | "missing";

export interface HideDeletedCtx {
  /** Schemas do escopo da consulta, usados para resolver tabelas sem schema. */
  schemas: string[];
  /** Estado da tabela: tem a coluna cw_deleted_at, nao tem, ou nao existe. Deve ser cacheado por quem implementa. */
  lookup(schema: string, table: string): Promise<TableState>;
  /** Chamado quando o SQL nao pode ser reescrito (motivo curto, sem dados). */
  onSkip?(reason: string): void;
}

export interface HideDeletedResult {
  sql: string;
  /** Quantas referencias foram reescritas (0 = SQL devolvido intacto). */
  rewritten: number;
  skipped: boolean;
}

const SENT = "cwhd_";
const SENT_RE = new RegExp(`^${SENT}(\\d+)_$`);

interface Found { item: Node; schema: string; schemaExact: boolean; table: string; tableExact: boolean; }
interface Resolved { schema: string; table: string; hit: boolean; }

export async function hideDeletedRows(input: string, ctx: HideDeletedCtx): Promise<HideDeletedResult> {
  const untouched = (skipped: boolean): HideDeletedResult => ({ sql: input, rewritten: 0, skipped });
  // Barato: sem nenhum FROM/JOIN/APPLY nao ha tabela a filtrar.
  if (!/\b(from|join|apply)\b/i.test(input)) return untouched(false);

  // Identificadores delimitados viram sentinelas (a caixa exata se preserva ate a volta)
  const quoted: string[] = [];
  const text = mapOutsideLiterals(input, (s) =>
    s.replace(/\[([^\]]+)\]|"((?:[^"]|"")+)"/g, (_m, br: string | undefined, dq: string | undefined) => {
      quoted.push(br ?? dq!.replace(/""/g, '"'));
      return `${SENT}${quoted.length - 1}_`;
    }),
  );
  const isSent = (id: string) => SENT_RE.test(id);
  const real = (id: string): string => {
    const m = SENT_RE.exec(id);
    return m ? quoted[Number(m[1])]! : id;
  };
  /** Nome a emitir: minusculo simples vai nu; o resto vira sentinela (caixa exata, mesmo no Postgres). */
  const ident = (name: string): string => {
    if (/^[a-z_][a-z0-9_$]*$/.test(name)) return name;
    quoted.push(name);
    return `${SENT}${quoted.length - 1}_`;
  };

  // O parser aceita `::` dentro de identificador (`id::int` vira coluna): nao e T-SQL, nao reescreve
  if (mapOutsideLiterals(input, (s) => (s.includes("::") ? "::" : "")).includes("::")) {
    ctx.onSkip?.("sintaxe Postgres (::)");
    return untouched(true);
  }

  let ast: Node;
  try {
    ast = parser.astify(text, { database: "transactsql" });
  } catch (e) {
    ctx.onSkip?.(`parse: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 120)}`);
    return untouched(true);
  }
  const stmts: Node[] = Array.isArray(ast) ? ast : [ast];

  // 1) coleta as referencias candidatas
  const found: Found[] = [];
  let ambiguous = false;
  const collect = (n: Node, ctes: Set<string>): void => {
    if (Array.isArray(n)) { for (const x of n) collect(x, ctes); return; }
    if (!n || typeof n !== "object") return;
    if (n.type === "select") {
      let scope = ctes;
      if (Array.isArray(n.with) && n.with.length) {
        scope = new Set(ctes);
        for (const c of n.with) scope.add(real(String(c.name?.value ?? "")).toLowerCase());
        for (const c of n.with) collect(c.stmt, scope); // o corpo enxerga os CTEs (inclusive recursivo)
      }
      if (Array.isArray(n.from)) {
        for (const it of n.from) {
          // `JOIN x ON c, outra_tabela`: o parser engole a tabela apos a virgula como parte da condicao ON
          if (it?.on?.type === "expr_list") ambiguous = true;
          if (!it || typeof it.table !== "string" || it.expr || it.temporal_table) continue;
          const table = real(it.table);
          if (it.schema || table.startsWith("#") || table.startsWith("@")) continue; // 3 partes / temp / variavel
          if (it.db) {
            found.push({ item: it, schema: real(it.db), schemaExact: isSent(it.db), table, tableExact: isSent(it.table) });
          } else if (!scope.has(table.toLowerCase())) {
            found.push({ item: it, schema: "", schemaExact: false, table, tableExact: isSent(it.table) });
          }
        }
      }
      for (const k of Object.keys(n)) if (k !== "with") collect(n[k], scope);
      return;
    }
    for (const k of Object.keys(n)) collect(n[k], ctes);
  };
  for (const s of stmts) collect(s, new Set());
  if (ambiguous) {
    ctx.onSkip?.("virgula apos condicao ON (parser ambiguo)");
    return untouched(true);
  }
  if (found.length === 0) return untouched(false);

  // 2) quais tem cw_deleted_at (lookups cacheados por quem implementa ctx; aqui so 1 por nome distinto)
  const memo = new Map<string, Promise<Resolved | null>>();
  const targets: { f: Found; r: Resolved }[] = [];
  for (const f of found) {
    const key = `${f.schema}|${f.schemaExact}|${f.table}|${f.tableExact}`;
    let p = memo.get(key);
    if (!p) { p = resolveOne(ctx, f); memo.set(key, p); }
    const r = await p;
    if (r?.hit) targets.push({ f, r });
  }
  if (targets.length === 0) return untouched(false);

  // 3) reescreve in place
  const unaliased = new Set<string>(); // `schema.tabela.coluna`: com a tabela virando derivada, o prefixo do schema sai
  for (const { f, r } of targets) {
    const it = f.item;
    if (!it.as && f.schema) unaliased.add(`${f.schema.toLowerCase()}|${f.table.toLowerCase()}`);
    const inner: Node = {
      with: null, type: "select", options: null, distinct: null,
      columns: [{ type: "expr", expr: { type: "column_ref", table: null, column: "*" }, as: null }],
      into: { position: null },
      from: [{
        db: f.schemaExact && r.schema === f.schema ? it.db : ident(r.schema),
        table: f.tableExact && r.table === f.table ? it.table : ident(r.table),
        as: null, table_hint: it.table_hint ?? null, temporal_table: null, operator: null,
      }],
      for: null,
      where: { type: "binary_expr", operator: "IS", left: { type: "column_ref", table: null, column: CW_DELETED_AT }, right: { type: "null", value: null } },
      groupby: null, having: null, top: null, orderby: null, limit: null,
    };
    const alias = it.as ?? it.table; // `FROM ds.t` -> alias `t`: `t.col` continua valendo
    for (const k of ["db", "schema", "table", "table_hint", "temporal_table"]) delete it[k];
    it.expr = { ast: inner, parentheses: true };
    it.as = alias;
  }

  if (unaliased.size) {
    const fix = (n: Node): void => {
      if (Array.isArray(n)) { for (const x of n) fix(x); return; }
      if (!n || typeof n !== "object") return;
      if (n.type === "column_ref" && typeof n.schema === "string" && typeof n.table === "string" && !n.db &&
          unaliased.has(`${real(n.schema).toLowerCase()}|${real(n.table).toLowerCase()}`)) n.schema = null;
      for (const k of Object.keys(n)) fix(n[k]);
    };
    fix(ast);
  }

  let out: string;
  try {
    out = parser.sqlify(ast, { database: "transactsql" });
  } catch (e) {
    ctx.onSkip?.(`sqlify: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 120)}`);
    return untouched(true);
  }
  // Volta os identificadores: sentinela -> [nome exato]; sem delimitador original -> nu (como o usuario escreveu)
  out = mapOutsideLiterals(out, (s) =>
    s.replace(/\[([^\]]+)\]/g, (_m, id: string) => {
      const sm = SENT_RE.exec(id);
      if (sm) return `[${quoted[Number(sm[1])]!.replace(/\]/g, "]]")}]`;
      return /^[A-Za-z_][\w$#@]*$/.test(id) ? id : `[${id}]`;
    }),
  );
  return { sql: out, rewritten: targets.length, skipped: false };
}

/** Resolve o schema real (sem schema informado: procura nos do escopo; ambiguo/inexistente = nao mexe) e se tem a coluna. */
async function resolveOne(ctx: HideDeletedCtx, f: Found): Promise<Resolved | null> {
  if (f.schema) return probe(ctx, f.schema, f.schemaExact, f.table, f.tableExact);
  const hits: Resolved[] = [];
  for (const s of ctx.schemas) {
    const r = await probe(ctx, s, true, f.table, f.tableExact);
    if (r) hits.push(r);
  }
  return hits.length === 1 ? hits[0]! : null; // 0 = nao existe; >1 = ambiguo (o qualificador do executor tambem nao escolhe)
}

/**
 * Caixa: delimitado = so a exata; sem delimitador = minuscula primeiro (o contrato dobra para minusculo no Postgres),
 * depois a exata (SQL Server com collation sensivel).
 */
async function probe(ctx: HideDeletedCtx, schema: string, schemaExact: boolean, table: string, tableExact: boolean): Promise<Resolved | null> {
  const variants = (v: string, exact: boolean) => (exact ? [v] : [...new Set([v.toLowerCase(), v])]);
  for (const s of variants(schema, schemaExact)) {
    for (const t of variants(table, tableExact)) {
      const st = await ctx.lookup(s, t);
      if (st !== "missing") return { schema: s, table: t, hit: st === "deleted" };
    }
  }
  return null;
}
