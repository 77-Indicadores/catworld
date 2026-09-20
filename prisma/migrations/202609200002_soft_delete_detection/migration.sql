-- Deteccao de exclusoes na origem por SOFT DELETE (substitui o desenho de lapides/escopo da 202609200001):
--  detect_deletions: liga a leitura da lista de chaves da origem no proprio incremental (default off);
--  keys_min_interval_minutes: valvula opcional (NULL = le as chaves em TODA rodada).
-- Aditiva (expand/contract): scope_columns, keys_check_cron e next_keys_check_at (da 202609200001) permanecem no
-- banco, sem uso, e serao removidas numa versao futura. keys_sql, last_keys_check_at e last_removed_count seguem em uso.
ALTER TABLE cw_dataset_sources ADD COLUMN IF NOT EXISTS detect_deletions BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE cw_dataset_sources ADD COLUMN IF NOT EXISTS keys_min_interval_minutes INTEGER NULL;
