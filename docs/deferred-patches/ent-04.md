# ENT-04 — modo `fallback` traduz pelo legado em silencio: design + patch (NAO aplicado; `apply.ts` e do dono)

## Problema
`runWithContract`/`contractTranslate` no modo `fallback` (o PADRAO): quando o motor novo REJEITA a consulta (ou o banco falha ao executar o SQL novo),
a consulta INTEIRA e traduzida pelo tradutor legado (regex). O legado executa `LIKE` sensivel a caixa, `DATEADD(month,n)` como n*30 dias, NULL ordenado ao contrario etc.
e o resultado volta como se fosse T-SQL correto, sem nenhum sinal para o cliente.

## Design
1. **Gate de semantica** (`legacyGate`, `ent-04/fallback-gate.ts`): antes de cair no legado, analisa o texto (fora de literais):
   * `block` — o legado e CONHECIDAMENTE diferente do SQL Server nesta consulta (LIKE, DATEADD/DATEDIFF em mes/trimestre/ano, DATEPART de semana,
     CHARINDEX/REPLACE, CAST/CONVERT para VARCHAR(n), TRY_CAST): o legado NAO e usado; sobe o `UNSUPPORTED_CONSTRUCT` do motor novo acrescido do motivo.
   * `warn` — diferenca so de borda (ORDER BY: ordem de NULL; LEN; ISNULL): usa o legado, mas...
2. **Aviso sempre**: todo resultado produzido pelo legado leva `warnings: ["LEGACY_TRANSLATION: ..."]` (via `attachWarnings`), e o `translate.ts` ganhou
   `ContractTranslation.warnings?` (ja commitado na branch). A rota `/queries` deve repassar `result.warnings` no meta (ela ja tem canal `warnings`; o SDK Python
   transforma warnings do servidor em `RuntimeWarning`).
3. **Erro do banco no SQL novo**: a retentativa no legado tambem passa pelo gate (se `block`, sobe o erro do SQL novo) e leva o aviso.
4. Contadores: novo `kind` `fallback-blocked` em `getContractStats().byKind` (para decidir quando ligar o `strict`).
5. Caminho de saida: quando `byKind["fallback-reject"]` cair a ~0 em producao, trocar o padrao de `getContractMode()` para `strict` (uma linha).

Modos `strict`, `shadow` e `off` nao mudam.

## Patch
`ent-04/apply.diff` (contra a versao COMMITADA de `src/server/sql-contract/apply.ts`; o dono tem alteracoes nao commitadas nesse arquivo — aplicar a mao as 3 regioes:
import, `legacyOrThrow` + uso em `contractTranslate` (ramo fallback) e os dois ramos de `runWithContract`).
Arquivo novo: `ent-04/fallback-gate.ts` -> `src/server/sql-contract/fallback-gate.ts`. Testes: `ent-04/fallback-gate.test.ts` -> mesma pasta
(usa `./apply` e `./fallback-gate`); os 18 testes existentes de `apply.test.ts` continuam verdes com o `apply.ts` modificado (rodados no prototipo).

## Testes (rodados) — 14 novos + 18 existentes verdes
legacyGate (bloqueia LIKE/mes/ano/CHARINDEX/varchar(n)/TRY_CAST; literais nao contam; ORDER BY/LEN/ISNULL so avisam); motor novo aceita = sem aviso;
rejeita + legado equivalente = usa E avisa; rejeita + LIKE = NAO executa, `UNSUPPORTED_CONSTRUCT` com motivo e contador `fallback-blocked`;
erro do banco -> retentativa com aviso, exceto quando bloqueada; `strict` e `shadow` inalterados.

## Decisoes do dono
* Consultas que hoje "passam" pelo legado com LIKE/mes/etc. passarao a receber 400 com a orientacao (ou o cliente reescreve). E o comportamento correto, mas e uma quebra visivel: avaliar `getContractStats().byKind["fallback-reject"]` antes.
* A lista do gate e conservadora e explicita (`BLOCK`/`WARN` no arquivo); ajustar conforme os dados de `shadow-diff`.
