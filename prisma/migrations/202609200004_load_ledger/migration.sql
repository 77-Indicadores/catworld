-- Livro de integridade das cargas (docs/estudo-confiabilidade-dados.md, secao 6): uma linha por tentativa de carga
-- (upload, refresh de fonte ou tabela derivada) com o que era esperado, o que foi lido/gravado e o veredito. Aditiva:
-- nao altera nenhum dado existente e nada depende dela para carregar (a escrita nunca derruba uma carga).
CREATE TABLE cw_load_ledger (
  id            UUID NOT NULL DEFAULT gen_random_uuid(),
  created_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  kind          VARCHAR(16) NOT NULL,
  dataset_id    UUID,
  table_id      UUID,
  upload_id     UUID,
  source_id     UUID,
  job_id        UUID,
  table_name    VARCHAR(255),
  mode          VARCHAR(20),
  attempt       INTEGER,
  outcome       VARCHAR(16) NOT NULL,
  verdict       VARCHAR(16) NOT NULL,
  expected_rows BIGINT,
  parsed_rows   BIGINT,
  physical_rows BIGINT,
  prev_rows     BIGINT,
  detail_json   TEXT,
  CONSTRAINT cw_load_ledger_pkey PRIMARY KEY (id)
);
CREATE INDEX cw_load_ledger_created_idx ON cw_load_ledger (created_at);
CREATE INDEX cw_load_ledger_table_idx ON cw_load_ledger (table_id, created_at);
CREATE INDEX cw_load_ledger_attention_idx ON cw_load_ledger (created_at) WHERE verdict <> 'OK';
