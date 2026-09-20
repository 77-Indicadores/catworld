/**
 * Onde e como inserir, no editor de SQL, o texto clicado no navegador de tabelas/colunas (função pura, testável).
 *
 * O problema que isto resolve: o editor começa em `SELECT TOP 100 *\nFROM ` e um clique numa tabela insere
 * `schema.tabela`. Um segundo clique (para "trocar" de tabela) só acrescentava — `FROM a.t1 a.t2` — e o Postgres
 * respondia `syntax error at or near "."`. Agora, clicar numa tabela com o cursor logo depois de um FROM/JOIN que já
 * tem uma tabela (sem alias) SUBSTITUI essa referência.
 */

const IDENT = String.raw`(?:\[[^\]]+\]|[A-Za-z0-9_$]+)`;
const QUALIFIED = new RegExp(`^${IDENT}\\.${IDENT}$`);
// FROM/JOIN + uma referência de tabela (1 ou 2 partes) colada no cursor, sem alias depois dela
const TABLE_REF_BEFORE_CURSOR = new RegExp(String.raw`\b(?:from|join)\s+(${IDENT}(?:\.${IDENT})?)$`, "i");

/** `schema.tabela` (é o que o navegador insere ao clicar numa tabela); coluna vem sem ponto. */
export function isQualifiedName(text: string): boolean {
  return QUALIFIED.test(text);
}

export interface InsertPlan { from: number; to: number; insert: string }

export function planInsert(doc: string, from: number, to: number, text: string): InsertPlan {
  const before = doc.slice(0, from);

  if (from === to && isQualifiedName(text)) {
    const m = TABLE_REF_BEFORE_CURSOR.exec(before);
    if (m) return { from: from - m[1]!.length, to, insert: text };
  }

  // Sem espaço depois de espaço, "(", ",", "." ou "[" — nos demais casos separa do texto anterior.
  const needsSpace = from > 0 && !/[\s(,.[]$/.test(before);
  return { from, to, insert: (needsSpace ? " " : "") + text };
}
