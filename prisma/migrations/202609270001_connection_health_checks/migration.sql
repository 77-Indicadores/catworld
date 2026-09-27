-- Health-check history + FK de conexao em cw_job_metrics.
-- Contexto: enqueueDueFirebirdFtpRefreshes (poll do FTP) e os botoes "Testar conexao"
-- nao deixavam nenhum rastro historico ("checamos e nao mudou nada"/"deu erro" sumia).
-- cw_health_checks e um log append-only generico (Connection ou StorageServer) pra isso.
-- connection_id/storage_server_id em cw_job_metrics permitem media de duracao por conexao
-- sem precisar de join por DatasetSource a cada consulta.

ALTER TABLE cw_job_metrics ADD COLUMN connection_id UUID;
ALTER TABLE cw_job_metrics ADD COLUMN storage_server_id VARCHAR(64);
ALTER TABLE cw_job_metrics ADD CONSTRAINT cw_job_metrics_connection_id_fkey
  FOREIGN KEY (connection_id) REFERENCES cw_connections(id) ON DELETE SET NULL;

CREATE INDEX IX_cw_job_metrics_connection_created ON cw_job_metrics(connection_id, created_at);

CREATE TABLE cw_health_checks (
  id                UUID         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  subject_type      VARCHAR(20)  NOT NULL,
  connection_id     UUID,
  storage_server_id UUID,
  kind              VARCHAR(10)  NOT NULL,
  outcome           VARCHAR(20)  NOT NULL,
  latency_ms        INTEGER,
  error_message     TEXT,
  created_at        TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  CONSTRAINT cw_health_checks_connection_id_fkey
    FOREIGN KEY (connection_id) REFERENCES cw_connections(id) ON DELETE CASCADE,
  CONSTRAINT cw_health_checks_storage_server_id_fkey
    FOREIGN KEY (storage_server_id) REFERENCES cw_storage_servers(id) ON DELETE CASCADE
);

CREATE INDEX IX_cw_health_checks_connection_created ON cw_health_checks(connection_id, created_at);
CREATE INDEX IX_cw_health_checks_storage_created ON cw_health_checks(storage_server_id, created_at);
