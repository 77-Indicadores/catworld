# A linguagem SQL do Catworld (contrato)

> **Modos** (`cw_system_settings`, chave `sql_contract.mode`; Configuracoes > Contrato de SQL):
>
> | Modo | Comportamento |
> |---|---|
> | `off` | Anterior ao contrato (regex no storage PG, SQL direto no live). |
> | `shadow` | Igual ao `off`, mas o motor novo roda em paralelo e loga (`tag: "sql-contract"`, `shadow-diff` / `shadow-reject`, sem literais) o que faria diferente. |
> | `fallback` (**padrao**) | Motor novo com rede de seguranca: se ele **rejeita** a consulta (`::`, `ILIKE`...) usa o caminho antigo; se o **banco falha** ao executar o SQL novo, refaz com o antigo e, se o antigo tambem falhar, devolve o erro antigo. Loga `fallback-reject` / `fallback-exec`. |
> | `strict` | So o motor novo; fora do contrato = `UNSUPPORTED_CONSTRUCT`. |
>
> No `fallback`, o que ja funcionava continua funcionando (inclusive SQL em estilo Postgres) e T-SQL que antes falhava passa a funcionar.
> Mudam de resultado apenas correcoes deliberadas: `TOP n` dentro de CTE/subquery passa a valer, `TOP n` no stream passa a valer
> (em `off`/`shadow` volta ao comportamento antigo), `truncated` passa a ser `true` quando ha mais linhas, e `DATEDIFF` conta
> fronteiras como no SQL Server (o antigo usava intervalos completos). Criar derivada com SQL que nao seja `SELECT` agora da 400.
>
> O formato de resultado normalizado e opt-in por requisicao (`"normalize": true` em `/queries` e
> `/dataset-sources/:id/query`, tambem no stream; o SDK expoe `normalize=True`). O CSV de export aceita `dateFormat=iso`
> (query string em `/tables/:id/export`, campo `dateFormat` em `/queries/export`).

**Voce escreve T-SQL. Sempre.** Em qualquer caminho — consulta no storage, live, derivada, SDK —
a linguagem e a mesma. O Catworld a traduz para o backend de destino.

| Caminho | Destino MSSQL | Destino Postgres |
|---|---|---|
| Consulta em dataset (`/queries`, export, SDK `query`) | executa como esta | traduz T-SQL -> Postgres |
| Live (`/dataset-sources/:id/query`) | executa como esta | traduz T-SQL -> Postgres |
| Tabela derivada | executa como esta | traduz T-SQL -> Postgres |

O SQL **nativo da propria fonte** (`sourceSql` de uma fonte por query) fica no dialeto da origem e nao e traduzido.

Somente leitura: uma instrucao, iniciando em `SELECT` ou `WITH`.

## Subconjunto garantido

`SELECT`, `WITH` (CTE), `JOIN`, `WHERE`, `GROUP BY`, `HAVING`, `ORDER BY`, `UNION`, funcoes de janela,
`TOP n` (inclusive em subquery/CTE), `OFFSET .. FETCH`, `[identificadores entre colchetes]`,
`WITH (NOLOCK)` (ignorado no Postgres).

| T-SQL | Postgres |
|---|---|
| `ISNULL(a,b)` | `COALESCE(a,b)` |
| `LEN(x)` | `LENGTH(x)` |
| `IIF(c,a,b)` | `CASE WHEN c THEN a ELSE b END` |
| `GETDATE()` / `GETUTCDATE()` / `SYSDATETIME()` | `NOW()` (instante; evita deslocamento de fuso no resultado) |
| `NEWID()` | `gen_random_uuid()` |
| `DATEADD(u,n,d)` | `d + n * INTERVAL '1 u'` |
| `DATEDIFF(u,a,b)` | conta **fronteiras** cruzadas (igual ao T-SQL) |
| `DATEPART(u,d)`, `YEAR/MONTH/DAY(d)` | `EXTRACT(...)` |
| `CHARINDEX(a,b[,inicio])` | `POSITION(a IN b)` (com `inicio`, equivalente por `SUBSTRING`) |
| `TRY_CAST/TRY_CONVERT(tipo)` numerico | `NULL` quando o texto nao e numero (tipos INT/BIGINT/DECIMAL/FLOAT...) |
| `CROSS APPLY` / `OUTER APPLY` | `CROSS JOIN LATERAL` / `LEFT JOIN LATERAL ... ON TRUE` |
| `CAST/CONVERT(tipo,...)` | tipos T-SQL mapeados (`NVARCHAR`->`TEXT`, `BIT`->`BOOLEAN`, `DATETIME2`->`TIMESTAMP`, ...) |
| `CONVERT(VARCHAR, d, estilo)` | `to_char` para os estilos 8, 20, 21, 23, 24, 101, 102, 103, 104, 105, 108, 110, 111, 112, 120, 121, 126, 127 |
| `'a' + 'b'` | `'a' \|\| 'b'` (so quando um lado e literal/texto conhecido; prefira `CONCAT`) |

Unidades de data suportadas: `year, quarter, month, week, weekday, dayofyear, day, hour, minute, second` (e abreviacoes).
Semana e dia da semana seguem o padrao do SQL Server (domingo = 1; `DATEDIFF(week)` conta domingos cruzados).

## Fora do contrato (erro `UNSUPPORTED_CONSTRUCT`)

`PIVOT/UNPIVOT`, `FOR XML/JSON`, `OPENQUERY/OPENROWSET`, `TRY_PARSE`, `TRY_CAST/TRY_CONVERT` para tipos nao numericos
(datas, bit), `TOP n PERCENT`, `DATEDIFF` em `millisecond`, `CONVERT` com estilo fora da lista, e o cast `::` (sintaxe Postgres;
use `CAST`/`CONVERT`). O erro vem do Catworld, com a construcao citada — nunca um erro cru do banco.

## Diferencas conhecidas por backend

- **Caixa dos identificadores:** `[Nome]` mantem a caixa exata. Sem colchetes, no Postgres o nome e
  dobrado para minusculas (o storage PG cria colunas com caixa exata). Prefira colchetes quando a coluna tem maiuscula.
- **Collation:** comparacao de texto e case-insensitive no SQL Server e case-sensitive no Postgres.
- **Aliases:** `AS Nome` sem colchetes sai em minusculas no Postgres.
- **TRY_CAST:** estouro de faixa (ex: numero maior que INT) gera erro no Postgres; no SQL Server devolve `NULL`.
- **DATEDIFF(week):** para datas anteriores a 1900-01-07 o resultado nao e garantido.

## Formato do resultado

Igual nos quatro caminhos (`columns, rows, rowCount, truncated, executionTimeMs`), com valores por tipo logico:

| Tipo | JSON |
|---|---|
| date | `"YYYY-MM-DD"` |
| datetime | ISO-8601 UTC |
| time | `"HH:MM:SS[.fff]"` |
| bigint, decimal | string |
| binary | base64 |

`truncated` e `true` quando havia mais linhas alem do `limit`; um `TOP n` do proprio usuario nunca marca truncado.

## Onde vive no codigo

`src/server/sql-contract/`: `translate.ts` (T-SQL -> Postgres), `result.ts` (tipos do resultado),
`run.ts` (entrada unica para o storage). Testes: `translate.test.ts`, `result.test.ts`.

## Acesso e somente leitura

**Quem pode consultar o quê** (`/queries`, `/queries/export`, stream):
- `datasetId`: exige acesso READ ao dataset (403 sem grant). `projectId`: só os datasets do projeto a que o ator tem acesso.
- Sem escopo: o SQL usa nomes qualificados; admin sem restrição, os demais só o que os grants alcançam (403 se nada).

**Storage Postgres** — isolamento por papel (`storage/pg-roles.ts`), equivalente aos principais do SQL Server:
- Cada ator não-admin tem um papel `cw_u_…`/`cw_t_…` (NOLOGIN) com USAGE + SELECT **só** nos schemas dos seus datasets; a
  consulta roda em `BEGIN READ ONLY` + `SET LOCAL ROLE`. Qualificar o nome de outro schema dá `permission denied`.
- Concessão/revogação sincronizada com cache de 60 s; tabelas criadas depois (troca de staging) já nascem legíveis.
- **Requisito:** a conta do storage precisa de `CREATEROLE` (ou ser superusuário; o app avisa no log se for). Sem isso, falha
  fechada com 503 `STORAGE_ROLE_SETUP_FAILED`. Válvula de escape: `PATCH /settings/sql-contract { "pgIsolation": "off" }`
  (loga aviso) — só até dar `CREATEROLE` à conta.
- `SET LOCAL` (timeout, search_path, papel) não vaza para a próxima consulta do pool.

**Somente leitura** (defesa em camadas):
1. Lista de palavras/funções bloqueadas (`sql-safety.ts`): comandos de escrita, `INTO`, `OPENROWSET/OPENQUERY/OPENDATASOURCE`,
   `WAITFOR`, `pg_read_file`, `pg_sleep`, `pg_terminate_backend`, `pg_ls_*`, `pg_advisory*`, `dblink*`, `lo_*`, `nextval`,
   `setval`, `set_config`… (`UNSAFE_SQL`). É a 1ª barreira, **não** a única.
2. Postgres: transação `READ ONLY` + papel sem privilégios de servidor. Fonte live/extract: `default_transaction_read_only = on`.
3. SQL Server: principal com grants de leitura.
