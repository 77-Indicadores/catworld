-- Antes desta migracao, uma falha no "Testar conexao" nao gravava nada no banco (so lastStatus="healthy"
-- em caso de sucesso) — uma conexao cujo teste mais recente falhou aparecia identica a uma nunca testada,
-- e o lastLatencyMs/lastCheckedAt exibidos podiam ser de um teste antigo bem-sucedido, escondendo a falha
-- atual. Migration ADITIVA: so acrescenta a coluna, nao altera dado existente.

ALTER TABLE cw_connections ADD COLUMN last_error TEXT;
