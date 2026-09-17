-- Suporte a tunel SSH nas conexoes (banco de origem atras de um host de salto,
-- nao exposto direto na rede). Segredo (senha ou chave privada) fica cifrado
-- com o mesmo esquema ja usado para a senha do banco (ver src/server/security/crypto.ts).

ALTER TABLE cw_connections
  ADD COLUMN ssh_tunnel_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN ssh_host VARCHAR(255),
  ADD COLUMN ssh_port INTEGER,
  ADD COLUMN ssh_username VARCHAR(255),
  ADD COLUMN ssh_auth_method VARCHAR(16),
  ADD COLUMN ssh_encrypted_secret VARCHAR(4000);
