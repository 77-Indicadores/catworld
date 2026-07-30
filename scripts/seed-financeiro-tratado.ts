/**
 * Registra a tabela derivada "financeiro_tratado" no dataset 77GESTAO do projeto MANINHO.
 * Execute após `npx prisma generate`:
 *   npx ts-node -e "require('./scripts/seed-financeiro-tratado.ts')"
 *   ou: npx tsx scripts/seed-financeiro-tratado.ts
 */
import { PrismaClient } from "@prisma/client";

const DATASET_ID   = "7523150a-1ac2-4edd-9827-fb631ea8a43f";
const SQL_NAME     = "financeiro_tratado";
const DISPLAY_NAME = "Financeiro Tratado";

const QUERY_SQL = `
SELECT
  id,
  type                                             AS tipo,
  description                                      AS descricao,
  ofx_raw_description                              AS descricao_ofx,
  CAST(value AS FLOAT)                             AS valor_bruto,
  CAST(net_value AS FLOAT)                         AS valor_liquido,
  CAST(discount AS FLOAT)                          AS desconto,
  CAST(financial_distribution_amount AS FLOAT)     AS valor_bruto_rateado,
  CASE WHEN ISNULL(CAST(value AS FLOAT), 0) = 0
       THEN 0.0
       ELSE ISNULL(CAST(net_value AS FLOAT), 0)
            * CAST(financial_distribution_amount AS FLOAT)
            / CAST(value AS FLOAT)
  END                                              AS valor_liquido_rateado,
  CASE WHEN ISNULL(CAST(value AS FLOAT), 0) = 0
       THEN 0.0
       ELSE ISNULL(CAST(discount AS FLOAT), 0)
            * CAST(financial_distribution_amount AS FLOAT)
            / CAST(value AS FLOAT)
  END                                              AS desconto_rateado,
  CASE WHEN ISNULL(CAST(value AS FLOAT), 0) = 0
       THEN 0.0
       ELSE CAST(financial_distribution_amount AS FLOAT) / CAST(value AS FLOAT)
  END                                              AS percentual_rateio,
  financial_distribution_owner_id                  AS centro_de_custo_id,
  financial_distribution_owner_name                AS centro_de_custo_nome,
  financial_distribution_owner_type                AS centro_de_custo_tipo,
  financial_distribution_distribution_type         AS tipo_rateio,
  CAST(financial_distribution_id AS NVARCHAR(MAX)) AS rateio_id,
  financial_distribution_created_at                AS rateio_criado_em,
  financial_distribution_updated_at                AS rateio_atualizado_em,
  due_date                                         AS data_vencimento,
  payday                                           AS data_pagamento,
  created_at                                       AS criado_em,
  updated_at                                       AS atualizado_em,
  CAST(code AS NVARCHAR(MAX))                      AS codigo,
  payment_method                                   AS forma_pagamento,
  notes                                            AS observacoes,
  category_id                                      AS categoria_id_ref,
  parent_id                                        AS lancamento_pai_id,
  CAST(rate AS FLOAT)                              AS taxa,
  financial_account_id                             AS conta_financeira_id_ref,
  ofx_unique_id                                    AS ofx_id_unico,
  issue_date                                       AS data_emissao,
  asaas_payment                                    AS pagamento_asaas,
  CAST(NULL AS NVARCHAR(MAX))                      AS arquivo_nota,
  CAST(NULL AS NVARCHAR(MAX))                      AS arquivo,
  CAST(category_id_2 AS NVARCHAR(MAX))             AS categoria_id,
  CAST(category_code AS NVARCHAR(MAX))             AS categoria_codigo,
  category_name                                    AS categoria_nome,
  category_created_at                              AS categoria_criado_em,
  category_updated_at                              AS categoria_atualizado_em,
  category_parent_id                               AS categoria_pai_id,
  CAST(category_active AS NVARCHAR(MAX))           AS categoria_ativo,
  category_type                                    AS categoria_tipo,
  CAST(account_id AS NVARCHAR(MAX))                AS conta_id,
  account_name                                     AS conta_nome,
  CAST(account_opening_balance AS NVARCHAR(MAX))   AS conta_saldo_inicial,
  CAST(account_default AS NVARCHAR(MAX))           AS conta_padrao,
  account_created_at                               AS conta_criado_em,
  account_updated_at                               AS conta_atualizado_em,
  category_name                                    AS categoria_texto
FROM [d_maninho_distribuidora_77gestao].[financial_releases]
`.trim();

const prisma = new PrismaClient();

async function main() {
  // Check if derived table already registered
  const existing = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT CONVERT(nvarchar(36), id) AS id FROM dbo.cw_derived_tables
     WHERE dataset_id = @P1 AND sql_name = @P2`,
    DATASET_ID,
    SQL_NAME,
  );

  if (existing.length > 0) {
    console.log("Tabela derivada já registrada:", existing[0].id);
    console.log("Para forçar refresh: POST /api/v1/derived-tables/" + existing[0].id + "/refresh");
    return;
  }

  // Find existing cw_tables record for financeiro_tratado
  const tableRows = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT CONVERT(nvarchar(36), id) AS id FROM dbo.cw_tables
     WHERE dataset_id = @P1 AND sql_name = @P2`,
    DATASET_ID,
    SQL_NAME,
  );
  const tableId = tableRows[0]?.id ?? null;
  console.log(tableId ? `Tabela existente encontrada: ${tableId}` : "Sem tabela existente, será criada no primeiro refresh");

  // Insert derived table record (tableId is from our own DB query, safe to inline)
  const newId = await prisma.$queryRawUnsafe<{ id: string }[]>(`
    DECLARE @id UNIQUEIDENTIFIER = NEWID();
    INSERT INTO dbo.cw_derived_tables
      (id, dataset_id, target_table_id, name, sql_name, query_sql, last_status, active)
    VALUES
      (@id, @P1, ${tableId ? `'${tableId}'` : "NULL"}, @P2, @P3, @P4, 'pending', 1);
    SELECT CONVERT(nvarchar(36), @id) AS id;
  `,
    DATASET_ID,
    DISPLAY_NAME,
    SQL_NAME,
    QUERY_SQL,
  );

  const derivedTableId = newId[0].id;
  console.log("Tabela derivada criada:", derivedTableId);

  // Enqueue refresh job
  await prisma.$executeRawUnsafe(`
    INSERT INTO dbo.cw_jobs (type, status, payload_json, max_attempts, weight, available_at)
    VALUES ('DERIVED_REFRESH', 'QUEUED', @P1, 2, 2, SYSUTCDATETIME())
  `,
    JSON.stringify({ derivedTableId }),
  );

  // Update status to queued
  await prisma.$executeRawUnsafe(
    `UPDATE dbo.cw_derived_tables SET last_status='queued' WHERE id=@P1`,
    derivedTableId,
  );

  console.log("Refresh enfileirado. O worker processará em seguida.");
  console.log("ID:", derivedTableId);
}

void main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
