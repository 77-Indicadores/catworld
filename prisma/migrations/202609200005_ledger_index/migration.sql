-- Indice do resumo de integridade (ultimo veredito por tabela): DISTINCT ON (dataset_id, table_name) ... ORDER BY created_at DESC
-- varria a tabela inteira do livro. Aditiva e sem CONCURRENTLY (a tabela e recente e pequena; o livro tem retencao de 90 dias).
CREATE INDEX IF NOT EXISTS cw_load_ledger_ds_table_idx ON cw_load_ledger (dataset_id, table_name, created_at DESC);
