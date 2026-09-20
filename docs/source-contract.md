# Contrato de fontes (dataset-sources) e tabelas derivadas

- Modos: `extract` (copia para o storage, com `keyColumn`/`deltaColumn`/reconciliacao) e `live` (consulta direta na origem). Tipos: `table` ou `query`.
- Criar fonte (`POST /datasets/:id/sources`): WRITE no dataset. Conexao: ADMIN/DATA_MANAGER livres; os demais so em conexoes que o **projeto** ja usa (403 `CONNECTION_FORBIDDEN`).
- Ler fontes: READ no dataset (grants de projeto valem).
- Crons (`refreshCron`, `reconciliationCron` e `refreshCron` de derivadas): expressao invalida e **400 `INVALID_CRON`** (antes era aceita e a fonte nunca atualizava). Vazio/null = sem agendamento.
- Derivada (`querySql`): somente leitura; so pode referenciar o schema do proprio dataset e de datasets que o autor le (403 `SCHEMA_FORBIDDEN`); ADMIN livre.
- Conflito de unicidade (ex.: tabela ja tem fonte): **409 `CONFLICT`** (antes 500), em qualquer rota.
- Detalhes: `GET /datasets/:id` -> 403 sem visibilidade; `GET /projects/:id` e `/projects/:id/datasets` listam so datasets visiveis.

## Exclusoes na origem (ciclo de vida)

Mecanismo unico, **soft delete**, opt-in por fonte. Com `detectDeletions: true`, cada carga incremental le tambem a **lista completa de chaves da origem** e, no **mesmo swap atomico** do merge, **marca** (`cw_deleted_at`; a linha permanece) as linhas ativas cuja chave sumiu. Linhas marcadas ficam escondidas de todos os leitores. So vale para fonte `extract` com `keyColumn`; sem chave a tabela e sempre substituida inteira. Com `detectDeletions: false` (padrao) o incremental nunca marca nada.

- **Campos por fonte** (`POST`/`PATCH`; todos opt-in): `detectDeletions` (boolean, padrao `false`), `keysSql` (string ou `null`) e `keysMinIntervalMinutes` (inteiro >= 1 ou `null` = a cada carga). Somente leitura: `lastKeysCheckAt` (ISO, ultima leitura de chaves concluida) e `lastRemovedCount` (linhas **marcadas como excluidas na ultima carga**). Fonte `live` ignora e zera os campos.
- **Validacao** (`assertDeleteDetection`, sempre contra o estado **mesclado** no `PATCH`; `null` limpa `keysSql`/`keysMinIntervalMinutes`; desligar `detectDeletions` e sempre permitido): 400 `DELETE_DETECTION_REQUIRES_KEY` (sem `keyColumn` ou fora de `extract`), 400 `KEYS_SQL_REQUIRED` (fonte `query` sem `keysSql`), 400 `KEYS_SQL_NOT_ALLOWED` (fonte `table` com `keysSql`), 400 `INVALID_KEYS_INTERVAL`. Em criacao de varias tabelas `detectDeletions` vale para todas e `keysSql` e recusado.
- **Chaves:** fonte **tabela** le so a coluna-chave da tabela; fonte **consulta** usa `keysSql`, com **uma unica coluna** e o mesmo formato da `keyColumn` (consulta que lista TODAS as chaves da origem, sem filtro de data).
- **Quando le:** em toda carga incremental; com `keysMinIntervalMinutes` (valvula de custo) so se passou esse intervalo desde `lastKeysCheckAt` (nas demais cargas o delta e aplicado sem marcar). Em carga que ja e snapshot completo (sem `deltaColumn`) a ausencia da staging ja marca, sem leitura extra.
- **Salvaguardas:** lista de chaves vazia, ou marcacao acima de **30 %** das linhas ativas (so avaliado com 50 linhas ou mais), **nao marca nada**; o delta e aplicado normalmente, a fonte fica `completed` e o aviso vai em `lastError` com o codigo `KEYS_CHECK_UNSAFE`. Outros erros da leitura de chaves (consulta invalida, origem fora) seguem o mesmo tratamento.
- **Reaparecimento:** uma chave marcada que volta a existir na origem e **reativada** (a marca cai) no merge seguinte.
- **Reconciliacao** (`reconciliationCron`): recarga completa opcional e manual/agendada, util para **deriva de valores** (linhas que mudaram sem mexer na coluna delta); nao e necessaria para exclusoes quando `detectDeletions` esta ligado.
- **Leitores nunca veem linhas marcadas:** export e OData filtram `cw_deleted_at IS NULL`; leitores SQL (consulta, derivadas, usuarios SQL) via **RLS do Postgres**. **SQL Server:** limitacao conhecida, o filtro so existe no export/OData (SQL direto pode ver linhas marcadas).
- **`since`:** `removedKeys` vem de `cw_deleted_at` (ver `table-contract.md`).
- **Observabilidade:** `lastRemovedCount`, mostrado no bloco Origem do detalhe da tabela junto de "Deteccao de exclusoes: ativa" e da ultima leitura de chaves. Log com contagens, **nunca valores de chave**; o `JOB_COMPLETED/FAILED` do worker segue como em `audit-contract.md`.
