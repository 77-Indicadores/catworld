# Contrato de tabelas, `since` e OData

Complementa `api-contract.md` (envelope, autenticação, erros) e `query-contract.md` (consulta SQL).

## Acesso

Todas as rotas abaixo exigem **acesso READ ao dataset** (grant GLOBAL, de projeto ou do dataset; ADMIN vê tudo). Antes:

- `GET /datasets/:id/tables` só exigia login: qualquer principal listava tabelas, colunas e origem de qualquer dataset.
- **OData** não checava o dataset: um token com grant só no dataset A lia o dataset B (e o documento de serviço/`$metadata`) pela URL.

Quem tinha o direito continua com o mesmo acesso. No OData o cache de token vale **15 s** (revogar um token tem efeito em até 15 s).

## `GET /api/v1/tables/:id/rows`

| Parâmetro | Regra |
|---|---|
| `limit` | inteiro ≥ 0, padrão 100, máximo 1000 (acima: usa 1000). `abc`/`-5` → **400 `VALIDATION_ERROR`** (antes: 500) |
| `since` | ISO-8601; só em fonte **extract** (`SINCE_NOT_SUPPORTED` no live) |
| `cursor` | opcional, junto com `since`: continua a página seguinte (ver abaixo) |

Sem `since` é uma **amostra** das primeiras `limit` linhas (sem `offset`): para ler tudo use `/queries` (`stream`) ou o export.

### `since` sem perda

Saída: `data` = linhas alteradas; `meta = { columns, rowCount, removedKeys, nextSince, hasMore, nextCursor?, removedTruncated?, tieGroupTruncated? }`.

**O defeito corrigido:** um sync grava o lote inteiro com o **mesmo** `cw_synced_at`. A paginação anterior (`> último timestamp`) perdia tudo
que passava do `limit` (reproduzido: 1000 de 2500 linhas; a 2ª chamada voltava vazia).

- **Sem `cursor`** (cliente que só segue `nextSince`, como sempre): a página **nunca corta um grupo empatado**; inclui o grupo inteiro
  (até 50 000 linhas), então pode trazer **mais que `limit`** — e `nextSince` sempre avança sem perder nada. Isso mantém funcionando,
  sem mudança de código, quem já fazia polling por `nextSince`.
- **Com `cursor`** (opcional): páginas estritas de `limit` linhas em ordem `(cw_synced_at, chave)`; siga `meta.nextCursor` (mandando
  o mesmo `since`) enquanto `meta.hasMore` for `true`. Necessário só para lotes maiores que 50 000 linhas (`tieGroupTruncated`) ou
  quando se quer páginas pequenas. Exige tabela com chave (upsert); sem chave, `INVALID_CURSOR`.
- **`removedKeys`** (exclusões): todas de uma vez na 1ª página (até 100 000; acima disso `removedTruncated: true`), sem o teto de `limit`
  de antes. Páginas de cursor não repetem as exclusões.
- `nextSince` da **última** página é o valor a guardar. Repetir linhas é seguro (upsert por chave); pular não acontece.
- **SDK:** `changes(table_id, since, limit, follow=True)` segue `hasMore` sozinho e devolve todas as mudanças; `follow=False` faz uma chamada só.
- **SQL Server:** o caminho do `since` continua como era (o ajuste é só Postgres; não verificado por falta de instância).
  Nele o limite de empates de timestamp ainda existe.

## OData (`/api/odata/{projeto}/{dataset}/{tabela}`)

Autenticação: `Authorization: Bearer`, Basic (senha = token) ou `?api_key=`. Preferir Bearer/Basic: `api_key` na URL aparece em logs
e é repetido nos `@odata.nextLink`.

| Opção | Suporte |
|---|---|
| `$top` (1–10 000, padrão 1000), `$skip`, `$select`, `$count=true` | sim (`@odata.count` respeita o `$filter`) |
| **`$filter`** | **subconjunto aplicado** (Postgres: storage e live): `eq ne gt ge lt le`, `and or not`, `()`, `null`, `true/false`, texto `'x'`, números, datas `2026-01-31`, datetimes, `contains/startswith/endswith(col,'x')`, `year/month/day(col)` |
| **`$orderby`** | **aplicado** (`col [asc|desc], …`; NULL é o menor valor, como no OData v4) |
| `$search $expand $apply $compute $levels $skiptoken $inlinecount` | ignorados, **com aviso** |
| SQL Server (storage e live) | `$filter`/`$orderby` ignorados **com aviso** (não implementado) |

- **Antes**, todo `$filter`/`$orderby` era ignorado em silêncio: `$filter=Id eq 1` devolvia a tabela inteira (o Power BI, que dobra filtros
  para o servidor, mostrava dado errado). Agora o suportado é aplicado.
- **Compatibilidade:** expressão que o servidor **não entende** continua sendo **ignorada** (comportamento anterior), mas a resposta
  traz o cabeçalho `Warning: 299 catworld "$filter ignorado: …"`. Nenhum cliente que funciona hoje passa a receber erro.
- Segurança: valores são validados e escapados (nunca vão crus para o SQL); colunas só pelo nome do catálogo; o `%`/`_`/`\` de
  `contains/startswith/endswith` é literal.
- `@odata.nextLink` carrega `$filter` e `$orderby`. `@odata.count` e `Edm.Int64`/`Decimal` saem como **texto**
  (`IEEE754Compatible=true`), conforme a especificação.
- Cache de página: 30 s; a chave inclui `$filter`/`$orderby`. O acesso ao dataset é verificado **antes** do cache.
- Cada linha ganha `_row_number` (chave sintética da página; não é estável se os dados mudarem).

## Limitações conhecidas

- OData no SQL Server: sem `$filter`/`$orderby`.
- `since` no SQL Server: ainda sujeito ao limite de empates.
- O nome da coluna no OData é o `sqlName` do catálogo (minúsculo no live), não o nome original.
