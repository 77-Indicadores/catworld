# Contrato de consulta e de resultado

Complementa `docs/sql-contract.md` (linguagem) e `docs/api-contract.md` (envelope, autenticação, erros).

## `POST /api/v1/queries`

Entrada:

| Campo | Padrão | Regra |
|---|---|---|
| `sql` | — | 1–50 000 caracteres; T-SQL, somente leitura |
| `datasetId` / `projectId` | — | escopo e **controle de acesso** (403 sem permissão). Sem escopo: nomes qualificados, só o que os grants alcançam |
| `limit` | 10 000 | 1–10 000 (acima disso: 400 `VALIDATION_ERROR`) |
| `offset` | 0 | ≥ 0 |
| `timeout` | 60 | 1–300 na entrada, mas **consultas paginadas são limitadas a 120 s** (aviso em `meta.warnings`); só o stream vai a 300 s |
| `stream` | false | NDJSON, ver abaixo |
| `normalize` | false | tipos normalizados (ver `sql-contract.md`) |

Saída (`data`): `{ columns, rows, rowCount, truncated, executionTimeMs }`.

- `columns` e as chaves de cada linha são os **nomes finais**. Colunas repetidas na consulta (`SELECT a.Id, b.Id …`) ganham sufixo
  determinístico: `Id`, `Id_2`, `Id_3` (a 1ª mantém o nome; nunca colide com um nome já existente). Vale para os caminhos Postgres
  (storage e live). **SQL Server: o driver junta nomes repetidos num array; ainda não há tratamento** (não verificado por falta de instância).
- `truncated`: `true` quando havia mais linhas além do `limit`. Um `TOP n` do próprio usuário nunca marca `truncated`.
- `rowCount` = linhas devolvidas nesta resposta.

## Cache

- Em memória, por instância, TTL de 5 min, máximo de 200 entradas **e 64 MB no total**; resultado acima de 2 MB não é cacheado.
- A chave inclui o SQL, o escopo, `limit`, `offset`, o principal, o storage, `normalize`, o **modo do contrato** e a **versão dos dados**
  do escopo (`max(last_data_at, updated_at)` e nº de tabelas dos datasets). Upload, sync e derivada gravam `last_data_at`, então uma
  consulta feita depois deles **nunca** recebe o resultado anterior. Alteração de dados feita fora do Catworld (direto no banco) só
  aparece depois do TTL.
- **HIT e MISS têm a mesma forma em `data`.** O que é do cache fica fora dele: `meta = { cached: true, cacheHits: n }` e os
  cabeçalhos `X-Cache: HIT|MISS` e `X-Cache-Hits`. (Antes, `cached` e `cacheHits` apareciam dentro de `data`, só no HIT.)
- O acesso ao dataset é verificado **antes** do cache: perder o grant tem efeito imediato.

## Tempo limite

Estouro de tempo devolve **408 `QUERY_TIMEOUT`** (antes: 400 `QUERY_FAILED` genérico); o SDK já o mapeia para `QueryTimeoutError`.
No stream, a linha final é `{"__error__":true,"message":"…","code":"QUERY_TIMEOUT"}`.

## Stream (`stream: true`, NDJSON)

- Ignora `limit`, `offset` e `timeout` (tempo fixo de 300 s); devolve **todas** as linhas.
- Linhas: `{"__columns__":[…]}`, depois uma linha por registro, e no fim `{"__done__":true,"rowCount":n,"executionTimeMs":ms}`.
- **O HTTP é 200 mesmo quando a consulta falha no meio**: o erro vem como `{"__error__":true,"message":"…","code"?:"…"}`.
  Regra para o cliente: **só há sucesso se a última linha for `__done__`**. Ausência de `__done__` (conexão cortada) também é falha.
- Erros antes de começar (validação, permissão, SQL inválido) voltam como JSON no envelope, com status 4xx.
- Sem `truncated` e sem envelope.

## Ainda em aberto (decisão pendente)

- `TOP n` + `offset`/`limit` no Postgres aplica o `offset` **antes** do `TOP` e não respeita o teto de 10 000 (o SQL Server aplica o
  `TOP` primeiro e o teto sempre). Mudar quebra quem usa `TOP 50000` para passar do teto.
- Formato sem `normalize` (decimal/bigint/data) difere entre backends.
- Paginação por `offset` sem `ORDER BY` não é determinística.
