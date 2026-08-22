/**
 * StorageConnection — abstração para backends de storage de datasets.
 *
 * Tipos canônicos (ColDef.sqlType):
 *   BIGINT | DECIMAL(18,4) | DATE | DATETIME2 | TIME | NVARCHAR(MAX)
 *
 * Cada adapter mapeia esses tipos para os tipos nativos do provider.
 */

import { prisma } from "@/server/db";
import { decryptSecret } from "@/server/security/crypto";

export type ColDef = {
  name: string;
  /** Tipo canônico: BIGINT | DECIMAL(18,4) | DATE | DATETIME2 | TIME | NVARCHAR(MAX) */
  sqlType: string;
  nullable: boolean;
};

export type ColInfo = {
  name: string;
  /** Tipo nativo do provider */
  sqlType: string;
  nullable: boolean;
};

export interface StorageConnection {
  readonly provider: "sqlserver" | "postgres";

  /** Retorna identificador SQL corretamente escapado ([name] ou "name") */
  q(identifier: string): string;

  createSchemaIfNotExists(schema: string): Promise<void>;
  dropSchemaIfExists(schema: string): Promise<void>;

  tableExists(schema: string, table: string): Promise<boolean>;
  createTable(schema: string, table: string, cols: ColDef[]): Promise<void>;
  dropTableIfExists(schema: string, table: string): Promise<void>;
  renameTable(schema: string, oldName: string, newName: string): Promise<void>;
  listTables(schema: string): Promise<string[]>;
  listColumns(schema: string, table: string): Promise<ColInfo[]>;
  countRows(schema: string, table: string): Promise<bigint>;

  /** Executa SQL raw e retorna linhas */
  query<T = Record<string, unknown>>(sql: string): Promise<T[]>;
  /** Executa SQL raw e retorna número de linhas afetadas */
  execute(sql: string): Promise<number>;

  /**
   * Bulk insert. rows[i][j] corresponde a cols[j].
   * Valores são convertidos para string e o adapter cuida do cast correto.
   */
  bulkInsert(schema: string, table: string, cols: ColDef[], rows: unknown[][]): Promise<void>;

  /**
   * Executa fn dentro de uma transação.
   * A transação faz commit ao retornar com sucesso, rollback em caso de erro.
   */
  withTransaction<T>(fn: () => Promise<T>): Promise<T>;

  /**
   * Troca atômica staging → target com janela de lock mínima em produção.
   *
   * fullSwap (sem keyColumn):
   *   DROP target (se existir) + RENAME staging → target dentro de transação breve.
   *   Lock em produção: ~ms.
   *
   * mergeSwap (com keyColumn):
   *   1. Materializa fora de transação: (rows de target cujo key NÃO está em staging) + (todos de staging)
   *      em uma tabela temporária — leituras na target não são bloqueadas.
   *   2. DROP target + RENAME temporária → target (transação breve, lock ~ms).
   *
   * A staging é sempre removida ao final (por rename ou DROP explícito).
   * Em caso de falha, staging e mergedName são removidas via best-effort.
   */
  atomicSwap(
    schema: string,
    staging: string,
    target: string,
    cols: ColDef[],
    opts?: {
      /** true se target já existe (default true) */
      targetExists?: boolean;
      /** Coluna-chave para mergeSwap. Sem keyColumn → fullSwap. */
      keyColumn?: string | null;
      /** Nome da tabela intermediária para mergeSwap. Obrigatório se keyColumn fornecido. */
      mergedName?: string;
    },
  ): Promise<void>;
}

// ─── Cache de conexões ────────────────────────────────────────────────────────

const connCache = new Map<string, StorageConnection>();

async function getDefaultStorageServerId(): Promise<string> {
  const server = await prisma.storageServer.findFirstOrThrow({
    where: { isDefault: true },
    select: { id: true },
  });
  return server.id;
}

/**
 * Retorna uma StorageConnection para o storageServerId dado.
 * Passe null/undefined para usar o StorageServer default.
 */
export async function getStorageConnection(
  storageServerId: string | null | undefined,
): Promise<StorageConnection> {
  const id = storageServerId ?? (await getDefaultStorageServerId());

  if (!connCache.has(id)) {
    const server = await prisma.storageServer.findUniqueOrThrow({
      where: { id },
      select: { id: true, provider: true, url: true, encryptedCredentials: true },
    });

    let resolvedUrl: string | null = null;
    if (server.encryptedCredentials) {
      try { resolvedUrl = decryptSecret(server.encryptedCredentials); } catch { /* fallback */ }
    }
    if (!resolvedUrl) resolvedUrl = server.url;
    if (!resolvedUrl) throw new Error(`StorageServer ${id} sem URL configurada`);

    // Import dinâmico para evitar circular deps
    if (server.provider === "postgres") {
      const { PgStorageConnection } = await import("./pg-storage");
      connCache.set(id, new PgStorageConnection(id, resolvedUrl));
    } else {
      const { MssqlStorageConnection } = await import("./mssql-storage");
      connCache.set(id, new MssqlStorageConnection(id, resolvedUrl));
    }
  }

  return connCache.get(id)!;
}

/** Invalida cache de uma conexão (chamar ao alterar credenciais) */
export function invalidateStorageConnection(storageServerId: string) {
  connCache.delete(storageServerId);
}
