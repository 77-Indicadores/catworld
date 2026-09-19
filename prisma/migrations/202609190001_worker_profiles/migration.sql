-- Workers deixam de ser configurados por variaveis de ambiente: cada worker e um PERFIL no banco (editado pela tela
-- de Configuracoes > Worker) e um supervisor le os perfis, sobe um processo por perfil e executa os comandos da tela
-- (reiniciar com seguranca / agora). Ver docs/worker-architecture.md.

CREATE TABLE cw_worker_profiles (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                VARCHAR(64) NOT NULL UNIQUE,
  job_types           TEXT[] NOT NULL,
  concurrency         INTEGER NOT NULL DEFAULT 1,
  poll_ms             INTEGER NOT NULL DEFAULT 2000,
  duckdb_memory_limit VARCHAR(16) NOT NULL DEFAULT '1GB',
  enabled             BOOLEAN NOT NULL DEFAULT TRUE,
  revision            INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ(3) NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ(3) NOT NULL DEFAULT NOW(),
  CONSTRAINT cw_worker_profiles_name_chk CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  CONSTRAINT cw_worker_profiles_types_chk CHECK (
    cardinality(job_types) >= 1
    AND job_types <@ ARRAY['PREVIEW_UPLOAD','IMPORT_UPLOAD','SOURCE_REFRESH','DERIVED_REFRESH','METADATA_CLEANUP']::text[]
  ),
  CONSTRAINT cw_worker_profiles_concurrency_chk CHECK (concurrency BETWEEN 1 AND 20),
  CONSTRAINT cw_worker_profiles_poll_chk CHECK (poll_ms BETWEEN 250 AND 60000),
  CONSTRAINT cw_worker_profiles_memory_chk CHECK (duckdb_memory_limit ~ '^[0-9]+(\.[0-9]+)?(MB|GB)$')
);

CREATE TABLE cw_system_commands (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action             VARCHAR(24) NOT NULL,
  mode               VARCHAR(12) NOT NULL DEFAULT 'SAFE',
  profile_id         UUID REFERENCES cw_worker_profiles(id) ON DELETE CASCADE,
  status             VARCHAR(12) NOT NULL DEFAULT 'PENDING',
  timeout_ms         INTEGER NOT NULL DEFAULT 600000,
  requested_by       VARCHAR(255) NOT NULL,
  requested_by_id    UUID,
  requested_at       TIMESTAMPTZ(3) NOT NULL DEFAULT NOW(),
  started_at         TIMESTAMPTZ(3),
  finished_at        TIMESTAMPTZ(3),
  result_json        TEXT,
  CONSTRAINT cw_system_commands_action_chk CHECK (action IN ('RESTART_PROFILE','STOP_PROFILE','START_PROFILE','RESTART_ALL','RESTART_SUPERVISOR')),
  CONSTRAINT cw_system_commands_mode_chk CHECK (mode IN ('SAFE','IMMEDIATE')),
  CONSTRAINT cw_system_commands_status_chk CHECK (status IN ('PENDING','ACCEPTED','DRAINING','APPLYING','DONE','FORCED','FAILED','CANCELLED','EXPIRED')),
  CONSTRAINT cw_system_commands_timeout_chk CHECK (timeout_ms BETWEEN 1000 AND 3600000)
);
CREATE INDEX cw_system_commands_status_requested_idx ON cw_system_commands (status, requested_at);

CREATE TABLE cw_supervisor_state (
  instance_id   VARCHAR(120) PRIMARY KEY,
  hostname      VARCHAR(255),
  pid           INTEGER,
  started_at    TIMESTAMPTZ(3) NOT NULL DEFAULT NOW(),
  heartbeat_at  TIMESTAMPTZ(3) NOT NULL DEFAULT NOW(),
  children_json TEXT
);

-- Perfis equivalentes ao que o docker-compose rodava (nomes iguais aos antigos CATWORLD_WORKER_ID, para manter a
-- continuidade de worker.liveness.*, cw_job_metrics e auditoria). METADATA_CLEANUP entra no worker-sync: com filtro de
-- tipos nenhum dos dois containers antigos rodava a limpeza diaria.
INSERT INTO cw_worker_profiles (name, job_types) VALUES ('worker-uploads', ARRAY['PREVIEW_UPLOAD','IMPORT_UPLOAD']) ON CONFLICT (name) DO NOTHING;
INSERT INTO cw_worker_profiles (name, job_types) VALUES ('worker-sync', ARRAY['SOURCE_REFRESH','DERIVED_REFRESH','METADATA_CLEANUP']) ON CONFLICT (name) DO NOTHING;

-- Limites de upload passam a viver no banco (antes: CATWORLD_UPLOAD_MAX_BYTES / CATWORLD_XLSX_MAX_BYTES).
INSERT INTO cw_system_settings (key, value, updated_at) VALUES ('upload.max_bytes', '524288000', NOW()) ON CONFLICT (key) DO NOTHING;
INSERT INTO cw_system_settings (key, value, updated_at) VALUES ('upload.xlsx_max_bytes', '41943040', NOW()) ON CONFLICT (key) DO NOTHING;
