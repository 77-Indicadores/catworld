-- Permite ao chamador da API (SDK) sobrepor o tipo SQL detectado automaticamente
-- para colunas especificas de um upload, antes do PREVIEW_UPLOAD rodar o import.
-- Ver src/worker/index.ts (aplicacao dos overrides em cima do preview auto-detectado).

ALTER TABLE cw_uploads ADD COLUMN type_overrides_json TEXT;
