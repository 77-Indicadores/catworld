/**
 * Colunas com o MESMO nome (ex: `SELECT a.Id, b.Id … JOIN`): um objeto por linha so guarda uma delas, e a
 * outra sumia em silencio. Contrato: nomes repetidos ganham sufixo deterministico (`Id`, `Id_2`, `Id_3`),
 * a 1a ocorrencia mantem o nome, e `columns` reflete os nomes finais. Vale para os caminhos Postgres.
 */
export function dedupeColumnNames(names: string[]): string[] {
  const used = new Set(names);
  const seen = new Set<string>();
  return names.map((name) => {
    if (!seen.has(name)) { seen.add(name); return name; }
    let k = 2;
    while (used.has(`${name}_${k}`)) k++;
    const next = `${name}_${k}`;
    used.add(next);
    seen.add(next);
    return next;
  });
}

/** Linhas em formato array (rowMode: "array" do pg) -> objetos, usando os nomes ja deduplicados. */
export function rowsFromArrays(rows: unknown[][], names: string[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < names.length; i++) obj[names[i]!] = row[i];
    return obj;
  });
}
