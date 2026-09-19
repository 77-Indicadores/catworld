-- Historico por tabela: liga cada execucao (job_metrics) a tabela que ela alimentou e registra quem enviou cada upload.
-- Colunas opcionais e aditivas: registros antigos ficam sem esses dados (a tela avisa) e nada existente muda.

ALTER TABLE cw_uploads ADD COLUMN created_by VARCHAR(255);

ALTER TABLE cw_job_metrics ADD COLUMN table_id UUID;
CREATE INDEX cw_job_metrics_table_id_created_at_idx ON cw_job_metrics (table_id, created_at);
