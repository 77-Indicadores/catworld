import { PrismaClient } from "@prisma/client";

const DATASET_ID = "7c43302d-905e-471e-8efb-77a123a30a72";

const SOURCES = [
  {
    name: "contas_a_pagar",
    sql: `SELECT
    fcp.cp_id AS id_conta_pagar,
    fcp.cp_data_lanc AS data_emissao,
    fcpp.cpp_data_venc AS data_vencimento,
    fcpp.cpp_data_pag AS data_pagamento,
    fcp.cp_ndoc AS numero_documento,
    fcp.cp_valor AS valor_previsto,
    fcp.cp_valor_pago AS valor_pago,
    fcp.cp_valor_real AS valor_real,
    fcp.cp_desconto AS desconto,
    fcp.cp_juros AS juros,
    fcp.cp_multa AS multa,
    fcp.cp_outros_acresc AS outros_acrescimos,
    fcp.cp_pago AS esta_pago,
    fcp.cp_historico AS descricao,
    fcp.cp_obs AS observacoes,
    fcp.tp_categoria_conta AS categoria_conta,
    fcp.pl_id_grupo AS grupo_plano_conta,
    fcp.pl_id AS id_plano_conta,
    fcp.em_codigo AS codigo_empresa,
    cli.[Razão Social] AS empresa_nome,
    fcp.en_codigo AS codigo_fornecedor,
    cli.[Nome Fantasia] AS fornecedor_nome,
    fcp.cp_status AS status_codigo,
    st.tp_descricao AS status_descricao,
    pl.pl_nome AS nome_plano_conta
FROM financ_contas_pagar fcp
LEFT JOIN financ_contas_pagar_parcelas fcpp ON fcp.cp_id = fcpp.cp_id
LEFT JOIN [bi].[pbi_clientes] cli ON CAST(fcp.en_codigo AS NVARCHAR) = cli.en_codigo
LEFT JOIN financ_plano_contas pl ON fcp.pl_id = pl.pl_id
LEFT JOIN t_tipos st ON fcp.cp_status = st.tp_id AND st.tg_id = 99`,
  },
  {
    name: "contas_a_receber",
    sql: `SELECT
    fcr.cr_id AS id_conta_receber,
    fcr.cr_data_lanc AS data_emissao,
    fcrp.crp_data_venc AS data_vencimento,
    fcrp.crp_data_pag AS data_pagamento,
    fcr.cr_ndoc AS numero_documento,
    fcr.cr_valor AS valor_previsto,
    fcr.cr_valor_pago AS valor_pago,
    fcr.cr_valor_real AS valor_real,
    fcr.cr_desconto AS desconto,
    fcr.cr_juros AS juros,
    fcr.cr_multa AS multa,
    fcr.cr_outros_acresc AS outros_acrescimos,
    fcr.cr_pago AS esta_pago,
    fcr.cr_historico AS descricao,
    fcr.cr_obs AS observacoes,
    fcr.tp_categoria_conta AS categoria_conta,
    fcr.pl_id_grupo AS grupo_plano_conta,
    fcr.pl_id AS id_plano_conta,
    fcr.em_codigo AS codigo_empresa,
    fcr.en_codigo AS codigo_cliente,
    cli.[Razão Social] AS cliente_nome_razao,
    cli.[Nome Fantasia] AS cliente_nome_fantasia,
    fcr.cr_status AS status_codigo,
    st.tp_descricao AS status_descricao,
    pl.pl_nome AS nome_plano_conta
FROM financ_contas_receber fcr
LEFT JOIN financ_contas_receber_parcelas fcrp ON fcr.cr_id = fcrp.cr_id
LEFT JOIN [bi].[pbi_clientes] cli ON CAST(fcr.en_codigo AS NVARCHAR) = cli.en_codigo
LEFT JOIN financ_plano_contas pl ON fcr.pl_id = pl.pl_id
LEFT JOIN t_tipos st ON fcr.cr_status = st.tp_id AND st.tg_id = 99`,
  },
  {
    name: "dproduto",
    sql: `SELECT
    pr_codigo AS id_produto,
    Produto AS nome_produto,
    pr_ativo AS ativo,
    tp_produto AS tipo_produto,
    [Sub Grupo] AS subgrupo,
    [Seção] AS secao,
    Grupo AS grupo,
    Fornecedor AS fornecedor
FROM bi.pbi_produtos`,
  },
  {
    name: "dvendedores",
    sql: `SELECT
    vn_codigo AS id_vendedor,
    en_codigo AS id_empresa,
    vn_ativo AS ativo,
    Vendedor AS nome_vendedor,
    fu_obs AS obs
FROM bi.pbi_vendedores`,
  },
  {
    name: "dcliente",
    sql: `WITH ultimos_vendedores AS (
    SELECT
        v.cl_codigo,
        v.vn_codigo AS id_vendedor,
        MAX(v.vd_data_venda) AS ultima_venda
    FROM dbo.t_vendas v
    WHERE v.vd_status IS NOT NULL
    GROUP BY v.cl_codigo, v.vn_codigo
),
ultimos_por_cliente AS (
    SELECT cl_codigo, id_vendedor
    FROM (
        SELECT *,
               ROW_NUMBER() OVER (PARTITION BY cl_codigo ORDER BY ultima_venda DESC) AS rn
        FROM ultimos_vendedores
    ) sub
    WHERE rn = 1
),
base_compras AS (
    SELECT
        c.cl_codigo AS id_cliente,
        c.[Razão Social] AS razao_social,
        c.[Nome Fantasia] AS nome_fantasia,
        c.en_cnpjcpf AS cnpj_cpf,
        c.tp_status AS status_cliente,
        c.cl_data_ultima_compra AS data_ultima_compra,
        MIN(v.vd_data_venda) AS data_primeira_compra,
        DATEDIFF(DAY, c.cl_data_ultima_compra, GETDATE()) AS dias_sem_compra,
        CASE
            WHEN DATEDIFF(DAY, c.cl_data_ultima_compra, GETDATE()) <= 40 THEN '🟢 Até 40 dias'
            WHEN DATEDIFF(DAY, c.cl_data_ultima_compra, GETDATE()) <= 60 THEN '🟡 Entre 41 e 60 dias'
            WHEN DATEDIFF(DAY, c.cl_data_ultima_compra, GETDATE()) <= 90 THEN '🟠 Entre 61 e 90 dias'
            ELSE '🔴 Acima de 90 dias'
        END AS faixa_sem_compra,
        SUM(CASE
                WHEN v.vd_bonif = 0 THEN (i.vi_valorunit * i.vi_qtd - (i.vi_rateio / 100.0 * v.vd_desconto))
                ELSE 0
            END) AS valor_total_comprado,
        e.ed_cep AS cep,
        c.uf_id AS uf,
        c.cd_descricao AS cidade,
        c.br_descricao AS bairro,
        c.ed_latitude AS latitude,
        c.ed_longitude AS longitude,
        u.id_vendedor,
        vdd.Vendedor AS nome_vendedor,
        bi.tp_segmento_descr AS segmento,
        bi.tp_grupo_segmento_descr AS grupo_segmento
    FROM dbo.t_vendas v
    LEFT JOIN dbo.t_vendas_itens i ON v.vd_codigo = i.vd_codigo
    LEFT JOIN bi.pbi_clientes c ON v.cl_codigo = c.cl_codigo
    LEFT JOIN dbo.t_enderecos e ON c.en_codigo = e.en_codigo
    LEFT JOIN ultimos_por_cliente u ON c.cl_codigo = u.cl_codigo
    LEFT JOIN bi.pbi_vendedores vdd ON u.id_vendedor = vdd.vn_codigo
    LEFT JOIN v_rpt_clientes_bi bi ON c.cl_codigo = bi.cl_codigo
    WHERE v.vd_status IS NOT NULL
    GROUP BY
        c.cl_codigo, c.[Razão Social], c.[Nome Fantasia], c.en_cnpjcpf,
        c.tp_status, c.cl_data_ultima_compra,
        e.ed_cep, c.uf_id, c.cd_descricao, c.br_descricao,
        c.ed_latitude, c.ed_longitude,
        u.id_vendedor, vdd.Vendedor,
        bi.tp_segmento_descr, bi.tp_grupo_segmento_descr
),
rankeado AS (
    SELECT *,
           RANK() OVER (ORDER BY valor_total_comprado DESC) AS posicao,
           SUM(valor_total_comprado) OVER () AS total_geral,
           SUM(valor_total_comprado) OVER (ORDER BY valor_total_comprado DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS acumulado
    FROM base_compras
),
classificado AS (
    SELECT *,
           CAST(1.0 * acumulado / total_geral AS FLOAT) AS perc_acumulado
    FROM rankeado
)
SELECT *,
       CASE
           WHEN perc_acumulado <= 0.80 THEN 'A'
           WHEN perc_acumulado <= 0.95 THEN 'B'
           ELSE 'C'
       END AS categoria_abc
FROM classificado`,
  },
  {
    name: "plconta",
    sql: `SELECT * FROM dbo.financ_plano_contas`,
  },
];

const prisma = new PrismaClient();

try {
  const dataset = await prisma.dataset.findUnique({ where: { id: DATASET_ID } });
  if (!dataset) throw new Error(`Dataset ${DATASET_ID} não encontrado`);
  console.log(`Dataset: ${dataset.name}`);

  const connection = await prisma.connection.findFirst({
    where: { provider: "mssql", active: true },
    orderBy: { createdAt: "asc" },
  });
  if (!connection) throw new Error("Nenhuma conexão mssql ativa encontrada");
  console.log(`Conexão: ${connection.name} (${connection.id})`);

  for (const source of SOURCES) {
    const existing = await prisma.datasetSource.findFirst({
      where: { datasetId: DATASET_ID, name: source.name, active: true },
    });
    if (existing) {
      console.log(`⏭  ${source.name} — já existe, pulando`);
      continue;
    }

    // Upsert the target table
    const { sqlIdentifier } = await import("../src/server/security/naming.js");
    const tableName = sqlIdentifier(source.name);
    const table = await prisma.datasetTable.upsert({
      where: { datasetId_sqlName: { datasetId: DATASET_ID, sqlName: tableName } },
      update: { name: source.name },
      create: { datasetId: DATASET_ID, name: source.name, sqlName: tableName },
    });

    const created = await prisma.datasetSource.create({
      data: {
        datasetId: DATASET_ID,
        connectionId: connection.id,
        targetTableId: table.id,
        name: source.name,
        mode: "extract",
        sourceKind: "query",
        sourceSql: source.sql,
        refreshPolicy: "hourly",
        lastStatus: "queued",
        nextRefreshAt: new Date(),
      },
    });

    // Queue the refresh job
    await prisma.job.create({
      data: {
        type: "SOURCE_REFRESH",
        payloadJson: JSON.stringify({ datasetSourceId: created.id }),
        maxAttempts: 3,
        weight: 2,
      },
    });

    console.log(`✅  ${source.name} — criado (${created.id})`);
  }
} finally {
  await prisma.$disconnect();
}
