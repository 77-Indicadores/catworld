-- Suporte a "puxar so o que mudou" (consumo incremental) via SDK/API. As colunas
-- cw_synced_at/cw_deleted_at sao internas e injetadas direto pelo atomicSwap nas TABELAS
-- FISICAS de cada dataset (nao no schema do Catworld em si) — ver
-- src/server/storage/mssql-storage.ts e src/server/storage/pg-storage.ts.
-- Aqui so precisamos da flag no upload, para o caso de upsert via SDK representar um
-- snapshot completo (habilita deteccao de exclusao).

ALTER TABLE cw_uploads
  ADD COLUMN full_snapshot BOOLEAN NOT NULL DEFAULT FALSE;
