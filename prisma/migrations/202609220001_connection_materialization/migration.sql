-- Estado de "conexoes baseadas em arquivo remoto" (docs/firebird-ftp-provider.md): o arquivo de origem precisa
-- ser baixado e materializado (restaurado) antes de virar algo consultavel, e isso e caro (rede + gbak), entao
-- roda no maximo uma vez por conexao, com TTL curto, em vez de uma vez por DatasetSource/refreshCron. Postgres
-- e SQL Server nunca preenchem isso. Aditiva: nao altera nenhuma tabela existente.
CREATE TABLE cw_connection_materializations (
  connection_id     UUID NOT NULL,
  remote_signature  VARCHAR(200),
  materialized_at   TIMESTAMP(3),
  expires_at        TIMESTAMP(3),
  status            VARCHAR(20) NOT NULL DEFAULT 'idle',
  firebird_host     VARCHAR(255),
  firebird_port     INTEGER,
  firebird_path     VARCHAR(500),
  last_error        TEXT,
  updated_at        TIMESTAMP(3) NOT NULL,
  CONSTRAINT cw_connection_materializations_pkey PRIMARY KEY (connection_id),
  CONSTRAINT cw_connection_materializations_connection_fkey FOREIGN KEY (connection_id)
    REFERENCES cw_connections (id) ON DELETE CASCADE ON UPDATE CASCADE
);
