/**
 * Diff estruturado entre o catalogo gravado de uma fonte e as colunas recem-introspectadas de OUTRA
 * conexao (usado ao criar uma fonte que substitui uma existente numa migracao). Nao substitui
 * `compareWithCatalog` (mantido intacto, com seus proprios testes) — so decompoe a mesma decisao em
 * categorias por coluna, pra o chamador poder distinguir "absorvido sem risco" de "quebra contrato".
 */
import { compareWithCatalog, type CatalogColumn, type ResolvedColumn } from "./source-values";

export type ColumnDiffCategory = "unchanged" | "new" | "removed" | "tolerated" | "structural";

export type StructuredColumnDiff = {
  sqlName: string;
  /** null = coluna nova, nao existia no catalogo antigo */
  catalogType: string | null;
  /** null = coluna sumiu na conexao nova */
  candidateType: string | null;
  category: ColumnDiffCategory;
};

export type StructuredDiff = {
  changed: boolean;
  changes: string[];
  columns: StructuredColumnDiff[];
  /** `removed`/`structural` quebram contratos externos (OData/Power BI); `tolerated`/`new`/`unchanged` nao. */
  hasBreakingChange: boolean;
};

export function buildStructuredDiff(current: ResolvedColumn[], catalog: CatalogColumn[] | undefined | null): StructuredDiff {
  const cmp = compareWithCatalog(current, catalog);
  const byOld = new Map((catalog ?? []).map((c) => [c.sqlName, c.sqlType]));
  const byNew = new Map(current.map((c) => [c.sqlName, c.sqlType])); // tipo bruto da conexao nova, antes da tolerancia
  const byResolved = new Map(cmp.columns.map((c) => [c.sqlName, c.sqlType])); // tipo que compareWithCatalog decidiu manter
  const names = new Set([...byOld.keys(), ...byNew.keys()]);
  const columns = [...names].map((sqlName): StructuredColumnDiff => {
    const catalogType = byOld.get(sqlName) ?? null;
    const candidateType = byNew.get(sqlName) ?? null;
    if (catalogType == null) return { sqlName, catalogType, candidateType, category: "new" };
    if (candidateType == null) return { sqlName, catalogType, candidateType, category: "removed" };
    if (catalogType === candidateType) return { sqlName, catalogType, candidateType, category: "unchanged" };
    return { sqlName, catalogType, candidateType, category: byResolved.get(sqlName) === catalogType ? "tolerated" : "structural" };
  });
  const hasBreakingChange = columns.some((c) => c.category === "structural" || c.category === "removed");
  return { changed: cmp.changed, changes: cmp.changes, columns, hasBreakingChange };
}
