# A linguagem SQL do Catworld (contrato)

> **Estado de adocao:** o contrato tem um modo em `cw_system_settings` (`key = 'sql_contract.mode'`):
> `off` = comportamento anterior; `shadow` (**padrao**) = responde como antes e loga (`tag: "sql-contract"`,
> `shadow-diff` / `shadow-reject`, sem literais) o que o motor novo rejeitaria ou traduziria diferente;
> `strict` = motor novo, com `UNSUPPORTED_CONSTRUCT`. Enquanto estiver em `shadow`, nada muda para quem ja usa.
> Ligue `strict` so depois de revisar os logs. O formato de resultado normalizado e opt-in por requisicao
> (`"normalize": true` em `/queries` e `/dataset-sources/:id/query`, tambem no stream; o SDK expoe `normalize=True`).
> O CSV de export aceita `dateFormat=iso` (query string em `/tables/:id/export`, campo `dateFormat` em `/queries/export`).
> O modo pode ser trocado em Configuracoes > Contrato de SQL.

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
| `GETDATE()` / `SYSDATETIME()` | `LOCALTIMESTAMP` |
| `GETUTCDATE()` | `NOW() AT TIME ZONE 'UTC'` |
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
