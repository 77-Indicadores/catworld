# Mudancas no contrato de SQL (T-SQL -> Postgres) — ENT-08..14 e S1

Complementa `docs/sql-contract.md` (que nao foi editado nesta entrega). Onde os dois divergem, vale este arquivo ate
o dono incorporar as mudancas ao contrato. Todas as mudancas estao em `src/server/sql-contract/translate.ts` e sao
verificadas por `translate-diff.pg.test.ts` (o SQL traduzido roda em Postgres real e e comparado com o resultado
documentado do SQL Server).

## Emulado (passa a valer por padrao)

| Construcao | Antes (Postgres) | Agora (= SQL Server) |
|---|---|---|
| `CAST/CONVERT(x AS VARCHAR(n))` (tambem NVARCHAR/CHAR/NCHAR) | ignorava `n` | trunca em `n` (`LEFT`); sem `n` = 30; `MAX` nao trunca |
| `CONVERT(VARCHAR(10), dt, 120)` | data e hora | so a data (texto do estilo truncado a `n`) |
| `LIKE '[a-c]%'`, `'[^a-c]%'`, `'[%]'` | colchete literal | classe de caracteres (padrao literal -> regex `~*` ancorada, sem caixa) |
| `LIKE 'x\%'` | `\` escapava o `%` | `\` e caractere comum (SQL Server nao tem escape padrao); `ESCAPE ''` explicito |
| `LIKE` com padrao montado por expressao contendo `[` literal | tratado como texto | rejeitado (UNSUPPORTED_CONSTRUCT); padrao dinamico sem `[` literal: caixa e barra corrigidas, classes vindas de DADOS sao texto |
| `LIKE ... ESCAPE 'c'` | erro de parse | rejeitado com mensagem clara (use `[%]`, `[_]`) |
| `TRY_CAST(10.5 AS INT)` | NULL | 10 (operando numerico trunca); `TRY_CAST('10.5' AS INT)` = NULL (texto); `''`/espacos = 0; fora da faixa = NULL (antes erro) |
| `TRY_CAST('' AS DECIMAL/FLOAT)` | NULL | 0 |
| `CHARINDEX(a, b)` | sensivel a caixa; `CHARINDEX('', x)` = 1 | ignora caixa; `CHARINDEX('', x)` = 0 |
| `REPLACE(s, f, r)` | sensivel a caixa | ignora caixa (alvo sem letras usa o REPLACE nativo) |
| `DATEADD(day, 1.5, d)` | soma 1,5 dia | soma 1 dia (trunca para zero) |
| `DATEADD(quarter, n, d)` | erro do banco | `n * 3` meses |
| `DATEADD(dia/mes/ano, n, CAST(x AS DATE))` | timestamp | DATE (so quando o operando e um `CAST(... AS DATE)` explicito) |
| `WITH c AS (... UNION ALL ... FROM c)` | erro do banco | `WITH RECURSIVE` emitido automaticamente |
| `SELECT TOP n ... UNION ...` (ramo com TOP) | `LIMIT` solto (SQL invalido ou vale para a uniao inteira) | o TOP vale so para o ramo; `ORDER BY` final vale para a uniao |
| `COUNT_BIG(x)`, `REPLICATE`, `SPACE`, `EOMONTH`, `DATEFROMPARTS` | erro do banco/parse | implementados |
| barra invertida em literal (`'a\'`) | o parser a tratava como escape (SQL corrompido) | literal comum |

## Rejeitado com `UNSUPPORTED_CONSTRUCT` (nunca erro cru do banco)

`FORMAT`, `DATENAME`, `ISNUMERIC`, `ISDATE`, `STRING_SPLIT`, `PATINDEX`, `STUFF`, `QUOTENAME`, `CHOOSE`, `PARSE`, `HASHBYTES`,
`CHECKSUM`, `BINARY_CHECKSUM`, `DATETIMEFROMPARTS`, `SYSDATETIMEOFFSET`, `SWITCHOFFSET`, `DATETRUNC`, `DATEDIFF_BIG`, `JSON_VALUE`,
`JSON_QUERY`, `OPENJSON`, `ISJSON`, `TRANSLATE`, `STRING_AGG`, `NATURAL JOIN` (nao existe em T-SQL; antes virava um alias
chamado `natural`).

`<coluna> + '5'` (literal de texto que parece numero, com operando de tipo desconhecido) e AMBIGUO: no SQL Server e soma se a
coluna for numerica e concatenacao se for texto. Antes virava concatenacao em silencio (`10 + '5'` = `'105'`); agora e rejeitado
com a sugestao `CONCAT(coluna, '5')` ou `CAST(coluna AS BIGINT) + 5`. Continuam iguais: `nome + ' '`, `nome + '-'` (literal que
nao parece numero), `1 + '5'`, `LEN(x) + '5'`.

## Opcional (desligado por padrao)

* `translateTsql(sql, "postgres", { avgTruncatesIntegers: true })`: `AVG(coluna inteira)` devolve inteiro truncado como no SQL
  Server (`AVG` de 10, 20, 7 = 12, nao 12,3333). Fica desligado porque muda numeros que clientes ja consomem: decisao do dono.
  `AVG` com `OVER (...)` nao e emulado.

## NAO emulado (diferencas conhecidas e agora documentadas)

* `ISNULL(a, b)`: o SQL Server devolve o tipo de `a` (e trunca `b`); o Postgres `COALESCE` devolve o tipo mais amplo
  (`ISNULL(int_col, 1.5)` = 1 no SQL Server, 1,5 aqui; `ISNULL(varchar(3), 'abcdef')` = 'abc').
* `=`, `IN`, `GROUP BY`, `DISTINCT`, `JOIN` e `ORDER BY` em texto: sensiveis a caixa no Postgres; e `'a' = 'a '` e falso aqui
  (o SQL Server ignora espacos finais na comparacao).
* `CAST(x AS VARCHAR)` de DATE/DATETIME sem estilo: o SQL Server devolve `Jan 31 2026 11:59PM` (estilo 0); aqui `2026-01-31...`.
  `CAST(numero AS VARCHAR(n))` estreito demais: o SQL Server devolve `*`; aqui trunca. `CAST(x AS CHAR(n))` nao completa com espacos.
* `DATEADD(dia, n, coluna_date)`: o tipo da coluna nao e visivel na traducao; o resultado sai timestamp (so `CAST(x AS DATE)`
  explicito preserva DATE). Circunlocucao: `CAST(DATEADD(...) AS DATE)`.
* `TRY_CAST(x AS DECIMAL(p,s))` que estoura a precisao: erro do Postgres (SQL Server devolve NULL).
* `LIKE '%' + coluna + '%'` (concatenacao no padrao) nao e aceito pelo parser T-SQL usado; use `CONCAT('%', coluna, '%')`.
