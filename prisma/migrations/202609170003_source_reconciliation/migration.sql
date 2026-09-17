-- Reconciliacao periodica (full snapshot) para fontes incrementais: cron secundario
-- opcional que roda a fonte sem o filtro de data, com fullSnapshot=true, servindo de
-- rede de seguranca contra exclusoes/divergencias fora da janela do incremental normal.

ALTER TABLE cw_dataset_sources
  ADD COLUMN reconciliation_cron VARCHAR(100),
  ADD COLUMN source_sql_reconciliation TEXT,
  ADD COLUMN next_reconciliation_at TIMESTAMP(3),
  ADD COLUMN last_reconciliation_at TIMESTAMP(3);
