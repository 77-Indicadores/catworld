-- maxSyncsPerStorage passa a ser enforçado no claim() (weight/max_heavy_jobs ja
-- fazia isso certo: o job sempre entra na fila, o teto so decide quando comeca a
-- rodar). Antes, o teto por storage era checado na hora de ENFILEIRAR
-- (enqueueDueSourceRefreshes), entao um job podia nunca chegar a existir se o
-- storage estivesse ocupado no instante exato do ciclo de 60s -- perdendo a vaga
-- repetidamente sem nunca ficar visivel esperando na fila.

ALTER TABLE cw_jobs
  ADD COLUMN storage_server_id VARCHAR(64);

CREATE INDEX cw_jobs_status_storage_server_id_idx ON cw_jobs (status, storage_server_id);
