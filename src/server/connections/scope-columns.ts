/** `scopeColumns` e guardado como JSON em texto; devolve array ou null (ausente/invalido/vazio). */
export function parseScopeColumns(text: string | null | undefined): string[] | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) && v.length && v.every(x => typeof x === "string") ? (v as string[]) : null;
  } catch { return null; }
}

/** Aparo, remove vazios/duplicados; vazio -> null. */
export function normalizeScopeColumns(cols: string[] | null | undefined): string[] | null {
  const out = [...new Set((cols ?? []).map(c => c.trim()).filter(Boolean))];
  return out.length ? out : null;
}

