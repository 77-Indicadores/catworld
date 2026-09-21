# Correções que dependiam de arquivos com alterações não commitadas do dono

> **APLICADAS na árvore de trabalho em 2026-09-21 (a pedido do dono), ainda NÃO commitadas** (o commit inclui o trabalho em andamento do dono nos mesmos arquivos): ENT-01 (`hide-deleted-run.ts` + `hide-deleted-text.ts` + teste), ENT-04 (`apply.ts` + `fallback-gate.ts` + teste + repasse de `warnings` em `queries/route.ts`), FON-09 (`derived.ts`: guarda de integridade, troca numa transação, `failed` visível, `derived.pg.test.ts`) e ENT-05 (`tables/[id]/rows/route.ts` + `route.pg.test.ts`). Testes: `sql-contract` 184 verdes, `derived.pg` 2/2 e `rows/route.pg` 3/3 contra Postgres real. Mudança de contrato visível: `hide-deleted.pg.test.ts` deixou de afirmar "SQL ilegível passa intacto" (agora é reescrito pelos tokens ou recusado). Os textos abaixo ficam como registro do design.

Estes itens do plano (`docs/estudo-confiabilidade-dados.md`) exigem editar arquivos que estavam com trabalho em andamento
(`src/server/sql-contract/hide-deleted*.ts`, `apply.ts`, `run.ts`, `src/server/connections/derived.ts`,
`src/app/api/v1/tables/[id]/rows/route.ts`, `docs/sql-contract.md`). Para não sobrescrever esse trabalho, cada um está
descrito aqui com o design, o patch e o protótipo testado. Aplicar **depois** de commitar o trabalho em andamento.

| Arquivo | Achado | O que faz |
|---|---|---|
| `ent-01.md` + `ent-01/` | ENT-01: o filtro de linhas excluídas falha aberto (18 de 89 consultas plausíveis passam sem filtro) | 3 barreiras: AST, reescrita por tokens e recusa `400 DELETED_FILTER_UNVERIFIABLE` quando não dá para provar o filtro. Protótipo com 15 testes verdes em Postgres real. |
| `ent-04.md` + `ent-04/` | ENT-04: o modo `fallback` traduz a consulta inteira pelo tradutor legado (LIKE vira sensível a caixa, mês = 30 dias…) | `legacyGate` bloqueia o fallback quando o legado é sabidamente diferente e, quando usa o legado, devolve `warnings: LEGACY_TRANSLATION`. 14 testes novos. O diff foi gerado contra o `apply.ts` commitado: aplicar as 3 regiões à mão. |
| `ent-05-route.md` | ENT-05: protocolo `rows?since=` | Patch da rota para usar a biblioteca já entregue (`since.ts`): microssegundos, UTC, janela de segurança, baseline paginado, `rowStamps`. |
| `fon-09.md` | FON-09: tabela derivada inclui linhas excluídas | Falha fechada no filtro de excluídas, guarda de integridade no `derived.ts` e swap atômico (hoje é DROP + RENAME em instruções separadas). |

Os arquivos `.ts.txt` são código-fonte (renomeados para não entrarem no typecheck/testes até serem aplicados).
