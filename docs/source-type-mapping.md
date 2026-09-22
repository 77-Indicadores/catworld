# Mapeamento de tipos das fontes conectadas

Regra geral: **um valor nao vazio da origem nunca vira NULL, nunca e arredondado e nunca depende do fuso do processo.** O que nao cabe
no tipo de destino faz a rodada falhar com mensagem acionavel (a tabela anterior permanece), em vez de gravar um valor diferente.
Implementacao: `src/server/connections/source-values.ts` (conversao), `source-pg-types.ts` (parsers do driver `pg`, so na conexao de
extracao), `postgres.ts` / `mssql.ts` (mapeamento de tipo). Testes: `source-values.test.ts`, `sources-reliability.pg.test.ts`.

## Postgres

| Tipo na origem | Tipo no storage | Representacao / observacao |
|---|---|---|
| `smallint`, `integer`, `bigint` | `BIGINT` | inteiro exato; valor nao inteiro falha |
| `numeric(p,s)`, p <= 38 | `DECIMAL(p,s)` | texto decimal exato (nunca `Number`); valor fora de p,s falha |
| `numeric` sem precisao, `numeric(p,s)` p > 38 | `NVARCHAR(MAX)` | texto exato, inclusive `NaN`, `Infinity`, `1e300` |
| `real`, `double precision` | `NVARCHAR(MAX)` | texto de ida e volta do Postgres (`0.1`, `NaN`, `Infinity`, `1e+300`) |
| `date` | `DATE` | `YYYY-MM-DD` cru; `infinity`, `BC` ou fora de 0001-9999 falham |
| `timestamp` | `DATETIME2` | `YYYY-MM-DD HH:MM:SS.ffffff`, microssegundos preservados, sem passar por `Date` |
| `timestamptz` | `DATETIME2` | convertido para UTC (sessao `TimeZone=UTC`); o deslocamento original nao e guardado |
| `time` | `TIME` | texto cru |
| `timetz` | `NVARCHAR(MAX)` | texto cru com deslocamento (`TIME` do storage nao guarda o deslocamento) |
| `json`, `jsonb` | `NVARCHAR(MAX)` | texto de saida do Postgres (jsonb ja e canonico; json preserva o texto original) |
| `bytea` | `NVARCHAR(MAX)` | hexadecimal `\xdeadbeef` (`bytea_output=hex`) |
| `interval` | `NVARCHAR(MAX)` | ISO 8601 (`P1Y2M3DT4H5M6S`, sessao `IntervalStyle=iso_8601`) |
| arrays (`int[]`, `text[]`, `jsonb[]`, ...) | `NVARCHAR(MAX)` | literal do Postgres (`{1,2,NULL}`), sem passar por array JS |
| `boolean` | `NVARCHAR(MAX)` | `true` / `false` |
| demais (`text`, `uuid`, `inet`, enum, ...) | `NVARCHAR(MAX)` | texto cru; byte NUL (0x00) falha (o storage nao aceita e remover alteraria o valor) |

A sessao de extracao fixa `TimeZone=UTC`, `IntervalStyle=iso_8601`, `bytea_output=hex`, `DateStyle=ISO, YMD`.

## SQL Server

O driver (`tedious`) entrega `decimal`/`numeric`/`money` como `number` (double) e datas como `Date`; isso limita a fidelidade:

| Tipo na origem | Tipo no storage | Observacao |
|---|---|---|
| `tinyint`, `smallint`, `int`, `bigint` | `BIGINT` | `bigint` chega como texto (exato) |
| `decimal(p,s)`, `numeric(p,s)` | `DECIMAL(p,s)` | valor com mais de 15 digitos significativos falha (`SOURCE_VALUE_PRECISION_LOSS`): nao e verificavel via double. Contorno: `CAST(col AS VARCHAR(40))` na consulta da fonte |
| `money` / `smallmoney` | `DECIMAL(19,4)` / `DECIMAL(10,4)` | idem |
| `float`, `real` | `NVARCHAR(MAX)` | texto do double |
| `date`, `datetime`, `smalldatetime`, `datetime2`, `datetimeoffset` | `DATE` / `DATETIME2` | lido como UTC (`useUTC: true`), **precisao de milissegundos** (limite do `Date` do JS: microssegundos/100ns de `datetime2(7)` sao perdidos); `datetimeoffset` vira o instante em UTC |
| `time` | `TIME` | texto |
| `binary`, `varbinary` | `NVARCHAR(MAX)` | hexadecimal `\x...` |
| demais | `NVARCHAR(MAX)` | texto; NUL falha |

## Fontes ja existentes (compatibilidade)

O catalogo gravado no ultimo carregamento e comparado com a estrutura atual (`compareWithCatalog`):

- `DECIMAL(18,4)` legado que comporta o novo `DECIMAL(p,s)` **e mantido** (nao forca recarga so pelo mapeamento mais fiel);
- coluna legada `DECIMAL(18,4)` que agora seria texto (float / numeric sem escala) **e mantida** como `DECIMAL(18,4)`, com o mesmo
  arredondamento de escala de sempre, mas `NaN`, `Infinity` e estouro **falham** (antes viravam NULL); chave nessa coluna e recusada;
- coluna nova, removida/renomeada ou de tipo incompativel = mudanca de estrutura: a tabela e recarregada por inteiro (fonte por tabela
  e reconciliacao) ou a rodada falha com `SOURCE_SCHEMA_CHANGED` e enfileira a reconciliacao (fonte por consulta com janela).

## Marca d'agua (coluna de incremento)

Guardada como texto canonico UTC `YYYY-MM-DD HH:MM:SS.ffffff` (temporal), inteiro exato (BIGINT) ou decimal exato; o formato antigo
(ISO com `Z`, milissegundos) continua legivel. Detalhes em `source-delta.ts`.
