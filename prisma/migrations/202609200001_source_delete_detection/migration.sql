-- Deteccao de exclusoes na origem por fonte incremental (opcional, tudo NULL = comportamento anterior):
--  scope_columns: JSON com colunas de escopo (grupo relido => chave ausente foi excluida);
--  keys_check_cron / keys_sql / *_keys_check_at: verificacao periodica da lista de chaves da origem.
ALTER TABLE cw_dataset_sources ADD COLUMN IF NOT EXISTS scope_columns TEXT NULL;
ALTER TABLE cw_dataset_sources ADD COLUMN IF NOT EXISTS keys_sql TEXT NULL;
ALTER TABLE cw_dataset_sources ADD COLUMN IF NOT EXISTS keys_check_cron VARCHAR(100) NULL;
ALTER TABLE cw_dataset_sources ADD COLUMN IF NOT EXISTS next_keys_check_at TIMESTAMP(3) NULL;
ALTER TABLE cw_dataset_sources ADD COLUMN IF NOT EXISTS last_keys_check_at TIMESTAMP(3) NULL;
-- last_removed_count: quantas linhas a ultima rodada removeu (exclusoes na origem; lapide em cw_tomb_<tabela>).
ALTER TABLE cw_dataset_sources ADD COLUMN IF NOT EXISTS last_removed_count BIGINT NULL;
