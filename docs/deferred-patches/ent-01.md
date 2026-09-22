# ENT-01 — filtro de excluidas que falha ABERTO: design + patch (NAO aplicado; arquivos do dono)

## Problema (reproduzido)
`hideDeletedRows` (AST, `node-sql-parser`) devolve o SQL ORIGINAL quando o parser nao le a consulta (`skipped: true`), e
`hideDeletedForStorage` engole isso ("nunca lanca"). Resultado: `cw_deleted_at IS NULL` some justamente em consultas que o
contrato aceita (TRY_CAST, EXCEPT, `LIKE ... ESCAPE`, `t.*`, ...). Para ADMIN, `pg_isolation=off` e SQL Server nao existe RLS
como segunda barreira, entao as linhas excluidas vazam. Prova executavel (Postgres real): teste
`REGRESSAO/PROVA` em `ent-01/hide-deleted-fail-closed.pg.test.ts` — para `TRY_CAST(...)`, `EXCEPT` e `LIKE ... ESCAPE` o AST devolve
`skipped: true, sql === entrada`.

## Design (3 barreiras, falha FECHADA)
1. **AST** (como hoje) — cobre o T-SQL comum.
2. **Reescrita por TOKENS** (`hide-deleted-text.ts`, novo): varre identificadores/[colchetes]/"aspas"/literais/comentarios/parenteses,
   acha `FROM|JOIN|, tabela [AS] alias` (todas as profundidades, ignora nomes de CTE, `#temp`, `@var`, tabela-funcao, 3 partes,
   `SUBSTRING(x FROM ...)`) e troca por `(SELECT * FROM <ref> WHERE cw_deleted_at IS NULL) AS <alias>`. Trata `schema.tabela.coluna`
   sem alias. Nao precisa de gramatica, entao cobre o que o parser nao le.
3. **Recusa**: se nem os tokens garantem o filtro (dica de tabela `WITH (...)`, `TABLESAMPLE`, parenteses desbalanceados, falha
   ao consultar o catalogo) E a consulta referencia tabela com `cw_deleted_at`, `hideDeletedForStorage` LANCA
   `DeletedFilterUnverifiable` (400 `DELETED_FILTER_UNVERIFIABLE`). Consulta sem tabela protegida passa intacta (byte a byte).
   Falha do catalogo tambem recusa (falha fechada).

Defesa em profundidade recomendada (fora deste patch, mexe em DDL/uploads): `ALTER TABLE ... FORCE ROW LEVEL SECURITY` no Postgres
(RLS passa a valer tambem para o dono) com a politica `cw_hide_deleted` deixando o pipeline de escrita ler tudo via um papel
proprio; e no SQL Server, uma VIEW/RLS equivalente.

## Arquivos (prontos, testados)
* `ent-01/hide-deleted-text.ts`  -> copiar para `src/server/sql-contract/hide-deleted-text.ts` (arquivo novo)
* `ent-01/hide-deleted-run.ts`   -> substitui `src/server/sql-contract/hide-deleted-run.ts` (diff em `ent-01/hide-deleted-run.diff`, contra a versao
  nao commitada do dono; unica mudanca de contrato: `hideDeletedForStorage` agora pode lancar `DeletedFilterUnverifiable`)
* `ent-01/hide-deleted-fail-closed.pg.test.ts` -> copiar para `src/server/sql-contract/` e trocar os imports `./hide-deleted-run`,
  `./hide-deleted-text`, `./hide-deleted` (ja sao relativos).

Chamadores de `hideDeletedForStorage` (`queries/route.ts` no ramo stream, `connections/derived.ts`, `sql-contract/run.ts`) nao
capturam excecoes: `DeletedFilterUnverifiable` e um `ApiError` (400) e vira resposta 400 normal. Verificar que nenhum `try/catch`
os engula (o `derived.ts` faz `await` direto).

## Testes (rodados no Postgres real 127.0.0.1:55433, schema unico) — 15/15 verdes no prototipo
TRY_CAST via pipeline completo; EXCEPT; ROLLUP; `t.*`; `LIKE ... ESCAPE`; join/virgula/subconsulta; CTE com nome de tabela; `schema.tabela.coluna`
sem alias; nome de tabela dentro de string/comentario (intacto); tabela sem a coluna (intacta); tabela sem schema resolvida pelo escopo;
`SUBSTRING(x FROM 1 FOR 1)` nao confundido com FROM de tabela; dica de tabela + tabela protegida -> recusa; mesma construcao em tabela sem a coluna -> passa;
catalogo indisponivel -> recusa com `status 400 / code DELETED_FILTER_UNVERIFIABLE`.

## Riscos / decisoes do dono
* Consultas que hoje "funcionam" vazando excluidas passam a ser reescritas (correto) ou recusadas (raro: dicas de tabela). Mensagem orienta a reescrever.
* O rewriter por tokens e uma heuristica lexica: subconsultas com `FROM` dentro de funcoes T-SQL desconhecidas sao tratadas como tabela (falha para o lado seguro: filtra ou recusa).
* Custo: 1 tokenizacao por consulta que o AST nao leu (so no caminho de falha).
