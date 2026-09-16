-- Lock por linha para serializar imports concorrentes na mesma tabela sem
-- precisar segurar uma transacao Postgres aberta durante todo o tempo do
-- trabalho externo no SQL Server (ver src/server/db/import-lock.ts).

CREATE TABLE cw_import_locks (
  lock_key   VARCHAR(160) NOT NULL PRIMARY KEY,
  locked_at  TIMESTAMP(3) NOT NULL,
  locked_by  VARCHAR(160) NOT NULL,
  expires_at TIMESTAMP(3) NOT NULL
);
