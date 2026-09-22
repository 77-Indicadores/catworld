/**
 * Marca "exactly-once" de um upload aplicado no destino (docs/estudo-confiabilidade-dados.md, MOT-01/MOT-11).
 *
 * O append não é idempotente: se o processo cai depois do COMMIT e antes dos metadados, a retentativa recarregava o arquivo e o
 * acrescentava de novo (50.000 virava 80.000). A marca é gravada NA MESMA TRANSAÇÃO do INSERT, no próprio banco de destino
 * (schema `cw_internal`, fora de qualquer dataset e sem grant para leitores). Se ela já existe, a retentativa não recarrega nada
 * e só reconcilia os metadados.
 */
import { markNonRetryable } from "./non-retryable";

export const MARKER_SCHEMA = "cw_internal";
export const MARKER_TABLE = "applied_uploads";

export const PG_MARKER_DDL = [
  `CREATE SCHEMA IF NOT EXISTS ${MARKER_SCHEMA}`,
  `CREATE TABLE IF NOT EXISTS ${MARKER_SCHEMA}.${MARKER_TABLE} (
     upload_id  uuid PRIMARY KEY,
     table_name text NOT NULL,
     mode       text NOT NULL,
     rows       bigint NOT NULL,
     applied_at timestamptz NOT NULL DEFAULT now()
   )`,
];

export const PG_MARKER_SELECT = `SELECT rows::text AS rows FROM ${MARKER_SCHEMA}.${MARKER_TABLE} WHERE upload_id = $1`;
export const PG_MARKER_INSERT = `INSERT INTO ${MARKER_SCHEMA}.${MARKER_TABLE} (upload_id, table_name, mode, rows) VALUES ($1, $2, $3, $4) ON CONFLICT (upload_id) DO NOTHING`;

/** SQL Server: o mesmo desenho (T-SQL). `uploadId` e `tableName` são inseridos por parâmetro, nunca por concatenação. */
export const MSSQL_MARKER_DDL =
  `IF SCHEMA_ID(N'${MARKER_SCHEMA}') IS NULL EXEC(N'CREATE SCHEMA ${MARKER_SCHEMA}');
   IF OBJECT_ID(N'${MARKER_SCHEMA}.${MARKER_TABLE}', N'U') IS NULL
     CREATE TABLE ${MARKER_SCHEMA}.${MARKER_TABLE} (
       upload_id  UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
       table_name NVARCHAR(255) NOT NULL,
       mode       NVARCHAR(20) NOT NULL,
       rows       BIGINT NOT NULL,
       applied_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
     );`;
export const MSSQL_MARKER_SELECT = `SELECT CAST(rows AS NVARCHAR(30)) AS rows FROM ${MARKER_SCHEMA}.${MARKER_TABLE} WHERE upload_id = @uploadId`;
export const MSSQL_MARKER_INSERT =
  `IF NOT EXISTS (SELECT 1 FROM ${MARKER_SCHEMA}.${MARKER_TABLE} WHERE upload_id = @uploadId)
     INSERT INTO ${MARKER_SCHEMA}.${MARKER_TABLE} (upload_id, table_name, mode, rows) VALUES (@uploadId, @tableName, @mode, @rows)`;

// ─── Criacao do registro (so para append) ────────────────────────────────────────────────────────────────────────────

const NO_PERMISSION = "Sem permissão para criar o registro exactly-once (schema cw_internal) no destino: o append foi recusado para não arriscar duplicar linhas numa retentativa. Peça ao administrador do banco para criar o schema/tabela cw_internal.applied_uploads ou conceder CREATE ao usuário do storage; upsert e replace não precisam dele.";
/** 23505 (unique_violation em pg_namespace/pg_type), 42P06 (schema existe), 42P07 (relacao existe), 42710 (tipo existe): outro import criou ao mesmo tempo. */
const PG_ALREADY = new Set(["23505", "42P06", "42P07", "42710"]);
/** 2714/2705 (objeto/coluna ja existe), 1913 (indice ja existe): idem no SQL Server. */
const MSSQL_ALREADY = new Set([2714, 2705, 1913]);

/**
 * Garante o registro no Postgres SO para append. Caminho rapido: se a tabela ja existe, nao roda DDL (nem exige permissao de CREATE).
 * Corrida (varios appends criando ao mesmo tempo: `CREATE SCHEMA IF NOT EXISTS` NAO e imune a corrida e falhava com 23505): tolera "ja existe".
 * Sem permissao (42501): falha ALTO em vez de seguir sem exactly-once.
 */
export async function ensurePgMarker(db: { queryParams<T>(sql: string, params: unknown[]): Promise<T[]>; execute(sql: string): Promise<unknown> }): Promise<void> {
  try {
    const present = await db.queryParams<{ ok: boolean }>(`SELECT to_regclass('${MARKER_SCHEMA}.${MARKER_TABLE}') IS NOT NULL AS ok`, []);
    if (present[0]?.ok) return;
  } catch (e) {
    if ((e as { code?: string }).code !== "42501") throw e; // sem USAGE no schema: cai no DDL, que falha alto se realmente nao ha permissao
  }
  for (const ddl of PG_MARKER_DDL) {
    try {
      await db.execute(ddl);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code && PG_ALREADY.has(code)) continue;
      if (code === "42501") throw markNonRetryable(new Error(NO_PERMISSION));
      throw e;
    }
  }
}

/** SQL Server: o mesmo (verifica antes; tolera "ja existe"; sem permissao 262/229/2760/15151 falha alto). */
export async function ensureMssqlMarker(run: (sql: string) => Promise<{ recordset?: { ok?: number }[] }>): Promise<void> {
  const present = await run(`SELECT CASE WHEN OBJECT_ID(N'${MARKER_SCHEMA}.${MARKER_TABLE}', N'U') IS NULL THEN 0 ELSE 1 END AS ok`);
  if (Number(present.recordset?.[0]?.ok) === 1) return;
  try {
    await run(MSSQL_MARKER_DDL);
  } catch (e) {
    const n = Number((e as { number?: number }).number);
    if (MSSQL_ALREADY.has(n)) return;
    if ([262, 229, 2760, 15151].includes(n)) throw markNonRetryable(new Error(NO_PERMISSION));
    throw e;
  }
}
