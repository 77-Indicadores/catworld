# Contrato de consulta e de resultado

Complementa `docs/sql-contract.md` (linguagem) e `docs/api-contract.md` (envelope, autenticação, erros).

## `POST /api/v1/queries`

Entrada:

| Campo | Padrão | Regra |
|---|---|---|
| `sql` | — | 1–50 000 caracteres; T-SQL, somente leitura |
| `datasetId` / `projectId` | — | escopo e **controle de acesso** (403 sem permissão). Sem escopo: nomes qualificados, só o que os grants alcançam |
| `limit` | 10 000 | 1–10 000 por página (acima disso: 400 `VALIDATION_ERROR`); vale também com `TOP n` |
| `offset` | 0 | ≥ 0 |
| `timeout` | 60 | 1–300 na entrada, mas **consultas paginadas são limitadas a 120 s** (aviso em `meta.warnings`); só o stream vai a 300 s |
| `stream` | false | NDJSON, ver abaixo |
| `normalize` | padrão configurável (`legacy`) | formato normalizado, recomendado (ver abaixo) |

Saída (`data`): `{ columns, rows, rowCount, truncated, executionTimeMs }`.

- `columns` e as chaves de cada linha são os **nomes finais**. Colunas repetidas na consulta (`SELECT a.Id, b.Id …`) ganham sufixo
  determinístico: `Id`, `Id_2`, `Id_3` (a 1ª mantém o nome; nunca colide com um nome já existente). Vale para os caminhos Postgres
  (storage e live). **SQL Server: o driver junta nomes repetidos num array; ainda não há tratamento** (não verificado por falta de instância).
- `truncated`: `true` quando havia mais linhas além do `limit`, inclusive dentro do conjunto de um `TOP n`.
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

## `TOP n`, `limit` e `offset` (igual no Postgres e no SQL Server)

- `TOP n` limita o **conjunto**; `limit` e `offset` paginam **dentro** dele. `TOP 2` com `offset=1` devolve só a 2ª linha.
- O teto de **10 000 linhas por página vale sempre**: `TOP 20000` devolve 10 000 com `truncated: true` (2ª página: `offset=10000`).
  `truncated` é `true` quando há mais linhas dentro do conjunto além do `limit`.
- Para ler mais que uma página de uma vez, use `"stream": true` (não tem teto de linhas).
- **Mudança de comportamento (Postgres):** antes o `TOP n` virava o limite de fora — o `offset` valia *antes* dele e `TOP 50000`
  devolvia 50 000 linhas de uma vez. Quem dependia disso deve usar `stream` ou paginar. A resposta avisa quando `TOP n > limit`.

## Formato do resultado: legado × normalizado

- **Normalizado** (`"normalize": true`) é o formato **recomendado**: datas ISO, `decimal`/`bigint` como texto, `time` como `HH:MM:SS`.
  É igual em todos os backends.
- **Legado** (sem `normalize`) é o formato do driver e varia por backend. Está **deprecado**: quando alguma coluna mudaria com
  `normalize`, a resposta traz um aviso em `meta.warnings` com os nomes dessas colunas, e o cabeçalho `X-Result-Format: legacy`.
- **Padrão configurável sem deploy:** `PATCH /api/v1/settings/sql-contract { "resultFormat": "normalized" }` (ou a tela Configurações >
  Contrato de SQL) muda o formato das requisições que **não** enviam `normalize`. Quem envia `normalize` explicitamente
  (`true` ou `false`) nunca é afetado. O padrão de fábrica continua `legacy`, para não quebrar ninguém; a migração é decisão do admin,
  cliente a cliente. Vale para `/queries` e `/dataset-sources/:id/query` (o export usa `dateFormat=iso`).

## Avisos (`meta.warnings`)

Não bloqueiam; a resposta é a mesma de sempre com um campo a mais em `meta`. O SDK Python os emite como `RuntimeWarning`.

| Aviso | Quando |
|---|---|
| paginação sem `ORDER BY` | `offset > 0` e a consulta não tem `ORDER BY` no nível de fora: a ordem não é garantida entre páginas (linhas podem repetir ou faltar) |
| `TOP n` acima do limite | `TOP n` com `n > limit`: o resultado vem paginado |
| formato legado | alguma coluna mudaria com `normalize: true` |
| timeout limitado | `timeout > 120` em rota paginada |

Escolha de projeto: paginação sem `ORDER BY` **avisa**, não retorna 400, porque exigi-lo quebraria clientes existentes (o
`iter_query` do SDK pagina por `offset`). Se um dia virar erro, será por configuração, com aviso prévio.

## Limitações conhecidas

- SQL Server: colunas de mesmo nome ainda não são tratadas (driver junta em array); não verificado por falta de instância.
- Alteração de dados feita fora do Catworld (direto no banco) só aparece depois do TTL do cache (5 min).
