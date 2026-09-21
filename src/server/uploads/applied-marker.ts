/**
 * Marca "exactly-once" de um upload aplicado no destino (docs/estudo-confiabilidade-dados.md, MOT-01/MOT-11).
 *
 * O append não é idempotente: se o processo cai depois do COMMIT e antes dos metadados, a retentativa recarregava o arquivo e o
 * acrescentava de novo (50.000 virava 80.000). A marca é gravada NA MESMA TRANSAÇÃO do INSERT, no próprio banco de destino
 * (schema `cw_internal`, fora de qualquer dataset e sem grant para leitores). Se ela já existe, a retentativa não recarrega nada
 * e só reconcilia os metadados.
 */
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
