# Contrato de fontes (dataset-sources) e tabelas derivadas

- Modos: `extract` (copia para o storage, com `keyColumn`/`deltaColumn`/reconciliacao) e `live` (consulta direta na origem). Tipos: `table` ou `query`.
- Criar fonte (`POST /datasets/:id/sources`): WRITE no dataset. Conexao: ADMIN/DATA_MANAGER livres; os demais so em conexoes que o **projeto** ja usa (403 `CONNECTION_FORBIDDEN`).
- Ler fontes: READ no dataset (grants de projeto valem).
- Crons (`refreshCron`, `reconciliationCron`, e `refreshCron` de derivadas): expressao invalida e **400 `INVALID_CRON`** (antes era aceita e a fonte nunca atualizava). Vazio/null = sem agendamento.
- Derivada (`querySql`): somente leitura; so pode referenciar o schema do proprio dataset e de datasets que o autor le (403 `SCHEMA_FORBIDDEN`); ADMIN livre.
- Conflito de unicidade (ex.: tabela ja tem fonte): **409 `CONFLICT`** (antes 500), em qualquer rota.
- Detalhes: `GET /datasets/:id` -> 403 sem visibilidade; `GET /projects/:id` e `/projects/:id/datasets` listam so datasets visiveis.
