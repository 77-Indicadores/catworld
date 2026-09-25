-- Move a migracao de storage (por projeto e por dataset) do request HTTP sincrono para o
-- sistema de jobs/worker existente (MIGRATE_STORAGE_PROJECT, MIGRATE_STORAGE_DATASET).
-- Migration ADITIVA: nao altera nenhum dado existente, so amplia a allowlist de tipos.

ALTER TABLE cw_worker_profiles DROP CONSTRAINT cw_worker_profiles_types_chk;
ALTER TABLE cw_worker_profiles ADD CONSTRAINT cw_worker_profiles_types_chk CHECK (
  cardinality(job_types) >= 1
  AND job_types <@ ARRAY[
    'PREVIEW_UPLOAD','IMPORT_UPLOAD','SOURCE_REFRESH','DERIVED_REFRESH','METADATA_CLEANUP',
    'MIGRATE_STORAGE_PROJECT','MIGRATE_STORAGE_DATASET'
  ]::text[]
);

-- Sem isso, os dois tipos novos ficariam "descobertos" (nenhum perfil habilitado os processa) e os
-- jobs so ficariam parados na fila ate alguem editar um perfil manualmente. Mesma faixa de peso (2 =
-- pesado) que DERIVED_REFRESH ja usa no worker-sync.
UPDATE cw_worker_profiles
SET job_types = job_types || ARRAY['MIGRATE_STORAGE_PROJECT', 'MIGRATE_STORAGE_DATASET']::text[]
WHERE name = 'worker-sync'
  AND NOT (job_types @> ARRAY['MIGRATE_STORAGE_PROJECT', 'MIGRATE_STORAGE_DATASET']::text[]);
