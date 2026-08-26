-- Tabela de histórico de execuções do METADATA_CLEANUP
CREATE TABLE cw_cleanup_runs (
  id               UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at      TIMESTAMPTZ,
  duration_ms      INTEGER,
  deleted_jobs     INTEGER     NOT NULL DEFAULT 0,
  deleted_audit    INTEGER     NOT NULL DEFAULT 0,
  deleted_uploads  INTEGER     NOT NULL DEFAULT 0,
  deleted_files    INTEGER     NOT NULL DEFAULT 0,
  deleted_orphans  INTEGER     NOT NULL DEFAULT 0,
  deleted_versions INTEGER     NOT NULL DEFAULT 0,
  error            TEXT
);

CREATE INDEX IX_cw_cleanup_runs_started ON cw_cleanup_runs(started_at DESC);
