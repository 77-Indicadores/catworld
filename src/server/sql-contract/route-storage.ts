/**
 * Em qual servidor de storage uma consulta roda.
 *
 * Um projeto pode ter datasets em servidores diferentes (ex.: parte no Azure SQL, parte no Postgres, apos migracao de
 * storage por dataset). Antes `/queries` usava o servidor do PRIMEIRO dataset do escopo (ordem nao garantida) ou o
 * padrao: `SELECT * FROM schema_do_outro_servidor.t` falhava com "Invalid object name" / "relation does not exist"
 * mesmo com a tabela existindo.
 *
 * Regra: o servidor vem dos schemas que o SQL cita (`referencedSchemas`), casados com os datasets que o ator le.
 *  - todos no mesmo servidor -> esse servidor;
 *  - servidores diferentes -> 400 MIXED_STORAGE (nao ha como juntar dois bancos numa consulta);
 *  - nenhum schema conhecido citado (nomes sem schema, so catalogo) -> comportamento anterior.
 */
import { ApiError } from "@/server/http";
import type { ScopeDataset } from "@/server/auth/permissions";
import { getDefaultStorageServerId } from "@/server/storage/connection";
import { referencedSchemas } from "./references";

export type StorageRoute = { storageServerId: string | null; schemas: string[] };

export function pickQueryStorage(i: {
  sql: string;
  /** datasets do escopo pedido (datasetId/projectId); vazio = sem escopo */
  scoped: ScopeDataset[];
  /** datasets que o ator le (para casar schemas citados fora do escopo) */
  accessible: ScopeDataset[];
  defaultId: string;
}): StorageRoute {
  const serverOf = (d: ScopeDataset) => d.storageServerId ?? i.defaultId;
  const bySchema = new Map<string, ScopeDataset>();
  for (const d of [...i.accessible, ...i.scoped]) bySchema.set(d.schemaName.toLowerCase(), d);

  const groups = new Map<string, string[]>(); // servidor -> schemas citados
  for (const s of referencedSchemas(i.sql)) {
    const d = bySchema.get(s);
    if (!d) continue; // information_schema, dbo, schema que o ator nao le: o banco decide
    const g = groups.get(serverOf(d)) ?? [];
    g.push(d.schemaName);
    groups.set(serverOf(d), g);
  }

  if (groups.size > 1) {
    const parts = [...groups.values()].map((g) => `[${g.join(", ")}]`).join(" e ");
    throw new ApiError(400, "MIXED_STORAGE",
      `A consulta junta schemas que estao em servidores de storage diferentes: ${parts}. Consulte cada grupo separadamente.`);
  }
  if (groups.size === 1) {
    const server = [...groups.keys()][0]!;
    // search_path / filtro de excluidas: so os schemas do escopo que estao NESSE servidor
    return { storageServerId: server, schemas: i.scoped.filter((d) => serverOf(d) === server).map((d) => d.schemaName) };
  }
  return { storageServerId: i.scoped[0]?.storageServerId ?? null, schemas: i.scoped.map((d) => d.schemaName) };
}

export async function resolveQueryStorage(sql: string, scope: { datasets: ScopeDataset[]; accessible: ScopeDataset[] }): Promise<StorageRoute> {
  return pickQueryStorage({ sql, scoped: scope.datasets, accessible: scope.accessible, defaultId: await getDefaultStorageServerId() });
}
