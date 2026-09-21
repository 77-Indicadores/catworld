import { createHash } from "node:crypto";

export function slugify(value: string, max = 100): string {
  const normalized = value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized) throw new Error("Nome não produz um identificador válido");
  return shorten(normalized, max);
}

export function sqlIdentifier(value: string, max = 128): string {
  let normalized = value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  if (!normalized) normalized = "campo";
  if (/^\d/.test(normalized)) normalized = `col_${normalized}`;
  if (RESERVED_COLUMN_NAMES.has(normalized)) normalized += RESERVED_COLUMN_SUFFIX;
  return shorten(normalized, max);
}

/**
 * Nomes de coluna reservados pelo Catworld (colunas internas de sincronização/exclusão e hash de linha). Uma coluna do usuário com
 * um destes nomes colidiria com a interna (TIP-12): é renomeada de forma determinística com o sufixo `_col`.
 */
export const RESERVED_COLUMN_NAMES: ReadonlySet<string> = new Set(["cw_deleted_at", "cw_synced_at", "_cw_rh", "cw_rh"]);
export const RESERVED_COLUMN_SUFFIX = "_col";

/** Limite de identificador do Postgres, em bytes (o nome é sempre ASCII aqui: bytes == caracteres). */
export const PG_IDENTIFIER_MAX = 63;

/** `base` com sufixo `_k`, cortando a base para o total caber em `max`. */
function withSuffix(base: string, suffix: string, max: number): string {
  return base.length + suffix.length <= max ? base + suffix : base.slice(0, max - suffix.length) + suffix;
}

/** Primeiro nome livre a partir de `base` (base, base_2, base_3...), nunca acima de `max`; registra o escolhido em `taken`. */
export function uniqueIdentifier(base: string, taken: Set<string>, max = 128): string {
  let candidate = base.length > max ? shorten(base, max) : base;
  for (let k = 2; taken.has(candidate); k++) candidate = withSuffix(base, `_${k}`, max);
  taken.add(candidate);
  return candidate;
}

/**
 * Deixa uma lista de identificadores única e dentro do limite do provedor, de forma determinística e estável: nomes que já cabem e
 * são únicos ficam como estão; os longos são encurtados com hash; colisões ganham `_2`, `_3`... (em loop até ficarem únicas).
 */
export function fitIdentifiers(names: string[], max = PG_IDENTIFIER_MAX): string[] {
  const taken = new Set<string>();
  const kept = names.map((n) => (n.length <= max && !taken.has(n) ? (taken.add(n), n) : null));
  return kept.map((n, i) => n ?? uniqueIdentifier(names[i]!, taken, max));
}

export function datasetSchema(projectSlug: string, datasetSlug: string): string {
  return sqlIdentifier(`d_${projectSlug.replaceAll("-", "_")}__${datasetSlug.replaceAll("-", "_")}`, 128);
}

function shorten(value: string, max: number) {
  if (value.length <= max) return value;
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 10);
  return `${value.slice(0, max - 11)}_${hash}`;
}

export function quoteIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/.test(value)) throw new Error(`Identificador SQL inválido: ${value}`);
  return `[${value}]`;
}