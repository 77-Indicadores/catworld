-- Faixas de worker (lanes). Migration ADITIVA: nao altera nenhum dado existente.
--
-- 1) Um perfil pode processar so certos "pesos" de job (0 e 1 = leves, 2 = pesados). Vazio = todos os pesos,
--    exatamente o comportamento anterior: nenhum perfil existente muda ate alguem aplicar um perfil de desempenho
--    com faixas (ou editar o perfil).
ALTER TABLE cw_worker_profiles ADD COLUMN weights INTEGER[] NOT NULL DEFAULT '{}';
ALTER TABLE cw_worker_profiles ADD CONSTRAINT cw_worker_profiles_weights_check CHECK (weights <@ ARRAY[0, 1, 2]::integer[]);

-- 2) Duracao media (EMA, em ms) das execucoes incrementais bem-sucedidas de cada fonte. Classifica o job em
--    rapido/longo na hora de enfileirar (ver classifySourceLane). NULL = sem historico ainda.
ALTER TABLE cw_dataset_sources ADD COLUMN avg_run_ms INTEGER;
