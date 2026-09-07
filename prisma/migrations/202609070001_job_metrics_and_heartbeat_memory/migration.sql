-- Camada 1 (auditoria): registro de memoria no heartbeat de cw_jobs + tabela
-- de metricas por job, que sobrevive a limpeza de cw_jobs (METADATA_CLEANUP).

ALTER TABLE cw_jobs ADD COLUMN heartbeat_rss_mb INTEGER;

CREATE TABLE cw_job_metrics (
  id              UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id          UUID        NOT NULL,
  job_type        VARCHAR(50) NOT NULL,
  status          VARCHAR(20) NOT NULL,
  weight          SMALLINT    NOT NULL,
  file_size_bytes BIGINT,
  rss_before_mb   INTEGER,
  rss_after_mb    INTEGER,
  duration_ms     INTEGER,
  error_message   TEXT,
  worker_label    VARCHAR(120),
  created_at      TIMESTAMP(3) NOT NULL DEFAULT NOW()
);

CREATE INDEX IX_cw_job_metrics_created ON cw_job_metrics(created_at);
CREATE INDEX IX_cw_job_metrics_type_created ON cw_job_metrics(job_type, created_at);
