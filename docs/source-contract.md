# Contrato de fontes (dataset-sources) e tabelas derivadas

- Modos: `extract` (copia para o storage, com `keyColumn`/`deltaColumn`/reconciliacao) e `live` (consulta direta na origem). Tipos: `table` ou `query`.
- Criar fonte (`POST /datasets/:id/sources`): WRITE no dataset. Conexao: ADMIN/DATA_MANAGER livres; os demais so em conexoes que o **projeto** ja usa (403 `CONNECTION_FORBIDDEN`).
- Ler fontes: READ no dataset (grants de projeto valem).
- Crons (`refreshCron`, `reconciliationCron`, `keysCheckCron`, e `refreshCron` de derivadas): expressao invalida e **400 `INVALID_CRON`** (antes era aceita e a fonte nunca atualizava). Vazio/null = sem agendamento.
- Derivada (`querySql`): somente leitura; so pode referenciar o schema do proprio dataset e de datasets que o autor le (403 `SCHEMA_FORBIDDEN`); ADMIN livre.
- Conflito de unicidade (ex.: tabela ja tem fonte): **409 `CONFLICT`** (antes 500), em qualquer rota.
- Detalhes: `GET /datasets/:id` -> 403 sem visibilidade; `GET /projects/:id` e `/projects/:id/datasets` listam so datasets visiveis.

## Exclusoes na origem (ciclo de vida)

Uma linha apagada na origem e **removida fisicamente** da tabela do Catworld; nenhum leitor (consulta SQL, derivadas, usuarios SQL, contagens, export, OData) ve linha velha. A chave removida vai para a **lapide** `cw_tomb_<tabela>` (mesmo schema: `cw_key` do tipo da chave, `cw_deleted_at` no relogio do storage), gravada na **mesma transacao/instrucao** da remocao. A tabela de lapide e interna: nunca entra no catalogo e e apagada junto com a tabela/fonte. So ha remocao em fonte `extract` com `keyColumn`; sem chave, a tabela e sempre substituida inteira.

| Quem detecta | Quando | O que remove |
|---|---|---|
| **Reconciliacao** (`reconciliationCron`, snapshot completo) e qualquer carga que le a origem inteira (tabela sem `deltaColumn`) | a cada snapshot | toda chave ausente da staging |
| **Escopo** (`scopeColumns`, opcional) | em toda carga incremental | chave ausente da staging **cuja tupla de escopo existe na staging** (todas as colunas de escopo nao nulas e iguais): o grupo foi relido por inteiro, entao o que nao veio foi excluido. Linhas de grupos que nao vieram, ou com escopo nulo, ficam como estao |
| **Verificacao de chaves** (`keysCheckCron`, opcional) | dentro da carga incremental, quando devida | chave ausente da lista de chaves da origem **e** com `cw_synced_at < inicio da leitura` (linhas carregadas depois do inicio nao sao tocadas: sem corrida) |

Tudo isso e opt-in por fonte; com os campos vazios o comportamento e o de antes (o incremental nunca remove).

- **`scopeColumns`** (JSON de nomes SQL da tabela destino; `POST`/`PATCH` recebem array, `null` limpa). Exige `keyColumn` (400 `SCOPE_REQUIRES_KEY`) e colunas existentes na fonte (400 `SCOPE_COLUMN_UNKNOWN`; em `PATCH` valida contra o catalogo da tabela; a carga revalida contra a fonte real). Em carga que ja e snapshot completo o escopo e desnecessario (nao e enviado).
- **`keysCheckCron`** (+ `nextKeysCheckAt`, `lastKeysCheckAt`): exige `keyColumn` (400 `KEYS_CHECK_REQUIRES_KEY`) e `mode: extract`; cron invalido = 400 `INVALID_CRON`. Fonte **tabela** le `SELECT <chave> FROM <tabela>`; `keysSql` nao e permitido (400 `KEYS_SQL_NOT_ALLOWED`). Fonte **consulta** exige `keysSql` (400 `KEYS_SQL_REQUIRED`): **uma unica coluna**, com os mesmos valores/formato da `keyColumn`. Em criacao de varias tabelas o escopo vale para todas (a coluna precisa existir em todas) e `keysSql` e recusado (por tabela). Fonte `live` ignora e zera esses campos.
- **Quando roda:** a verificacao **nao cria job proprio**. Pega carona na carga incremental (mesma trava `running`, depois do merge) e roda na **primeira carga incremental apos `nextKeysCheckAt`** (inclusive a manual); nao roda na reconciliacao nem em carga que ja e snapshot completo, e nao ha nada a verificar na primeira carga. Uma fonte so com `keysCheckCron` (sem `refreshCron`) so verifica quando alguem dispara a atualizacao. Depois de rodar (ou de abortar), `nextKeysCheckAt` avanca pelo cron; `lastKeysCheckAt` so muda quando a verificacao concluiu.
- **Leitura das chaves:** em lotes de 5000 para `cw_keys_<idfonte>` (tabela auxiliar no schema, apagada no `finally`); o inicio (`startedAt`) vem do **relogio do servidor de storage**, o mesmo que carimba `cw_synced_at`.
- **Salvaguardas (antes de remover):** lista de chaves vazia, ou remocao acima de **30 %** das linhas (`KEYS_CHECK_MAX_RATIO`; so avaliado com 50 linhas ou mais) aborta com `KEYS_CHECK_UNSAFE` (409): nada e removido. A carga ja concluida **nao falha**: a fonte fica `completed` e o aviso vai em `lastError` ("Verificacao de chaves: KEYS_CHECK_UNSAFE - ..."); o job nao e repetido. Qualquer outro erro da verificacao (consulta de chaves invalida, origem fora) segue o mesmo tratamento.
- **Reaparecimento:** o merge que reinsere uma chave presente na staging (incremental, reconciliacao ou upload por chave) apaga a lapide dela na mesma transacao.
- **Validade das lapides:** `retention.tombstone_days` (padrao **30**, `0` = guardar para sempre; `PATCH /settings/retention`, 0-3650; tela Configuracoes > Retencao). Purgadas no inicio de cada carga da fonte (mesma trava). Consumidor com `since` mais antigo que a validade recebe `meta.removedIncomplete: true` e deve ressincronizar (ver `table-contract.md`).
- **Formato legado:** tabelas com linhas `cw_deleted_at IS NOT NULL` (soft delete antigo) sao convertidas **uma vez**, no inicio da proxima carga da fonte (idempotente): a chave vira lapide (com o carimbo original) e a linha e removida. Ate la, `since` ainda entrega essas chaves (uniao) e `active-rows.ts` continua escondendo-as de export/OData.
- **Observabilidade:** `lastRemovedCount` (linhas removidas na ultima carga: merge + verificacao), mostrado no bloco Origem do detalhe da tabela junto de escopo, cron de chaves e ultima verificacao. Log `[source-refresh] keys check ... keys=N marked=M` (contagens, **nunca valores de chave**); o `JOB_COMPLETED/FAILED` do worker segue como em `audit-contract.md`.
- **Peso do job:** inalterado (a leitura da chave e de uma coluna so).
