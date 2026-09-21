# Integridade dos dados: política, livro de cargas e monitoramento

Contrato operacional que decorre de `docs/estudo-confiabilidade-dados.md`. Requisito máximo: **o Catworld nunca publica uma tabela que ele mesmo sabe estar incompleta**. Dado que já veio errado da origem é registrado como recebido; perda, duplicação, arredondamento ou deslocamento introduzidos por nós são defeitos.

## 1. A barra de integridade (antes de publicar)

Toda carga (upload, refresh de fonte, tabela derivada) compara três coisas, em `src/server/integrity/policy.ts` (`evaluateLoad`):

| Comparação | Regra | Veredito |
|---|---|---|
| lido × **esperado** (contagem do arquivo/da origem, independente da carga) | menos linhas que o esperado, tolerância zero | bloqueia |
| lido × esperado | mais linhas que o esperado (os leitores discordam) | suspeito |
| lido × staging | número diferente | bloqueia |
| substituição completa por **0 linhas** sobre tabela que tinha dados | a menos que `allow_empty` | bloqueia |
| queda maior que `max_drop_pct` (padrão 30%) contra a versão anterior (só tabelas com ≥ 50 linhas) | fonte agendada bloqueia; upload manual marca suspeito | bloqueia / suspeito |
| retentativa sem contagem esperada para conferir | — | suspeito |

**Bloqueia** = a carga falha com `[integrity] <CÓDIGO>: …` e **a tabela anterior continua no ar, completa**. **Suspeito** = publica e a tabela aparece como "Possivelmente incompleta" no dashboard. Modo `warn` transforma "bloqueia" em "suspeito".

`phase2` (SDK mandou só a diferença) não usa as contagens do arquivo. Append/upsert conferem o esperado, mas não têm regra de queda/vazio (não substituem o estado).

### Configuração (ADMIN)

`GET/PATCH /api/v1/settings/integrity`: `mode` (`enforce` padrão | `warn`), `max_drop_pct` (1–99), `allow_empty` (boolean). Valor ausente ou inválido cai no padrão: **nunca desliga a proteção por engano**. A mudança é auditada (`INTEGRITY_SETTINGS_CHANGED`).

> **Atenção ao implantar:** com `enforce`, cargas que hoje "funcionam" com linhas faltando (por exemplo, uma diferença constante entre a contagem do preview e a lida) passam a **falhar** em vez de publicar dado incompleto. Para começar observando, use `mode=warn` por alguns dias e olhe `GET /api/health/integrity`.

## 2. Livro de cargas (`cw_load_ledger`)

Uma linha por **tentativa** de carga, na mesma transação que publica (upload PG/SQL Server, refresh de fonte) e também nas falhas: `kind`, `outcome`, `verdict`, esperado/lido/físico/anterior, `mode`, `table_name`, `attempt` e `detail_json` (motivos estruturados, método de importação, parser). Escrito por SQL direto e **nunca derruba uma carga**. Uma falha de integridade também grava o evento de auditoria `DATA_INTEGRITY_SUSPECT` (`success=false`).

O resumo (`summarizeIntegrity`) decide o estado atual por **dataset + tabela**: uma carga OK posterior encerra o alerta.

## 3. Onde aparece

- **Dashboard/tabela:** estado `Possivelmente incompleta` (gravidade 7, acima de "Com erro"), com o motivo. Uma fonte "Na fila"/"Atualizando" há mais de 30 min depois do previsto passa a **Atrasada** (antes ficava "em andamento" para sempre).
- **Monitor:** `GET /api/health/integrity`. Sem login só devolve `degraded`; autenticado, o detalhe (tabelas, contagens, quedas de worker na última hora, idade da fila). `degraded` = alguma tabela com veredito pendente, 3+ `WORKER_CRASHED` na última hora ou job na fila há mais de 30 min. Se não consegue avaliar, responde 503 `degraded:true` (nunca "tudo bem" por engano).
- **`WORKER_CRASHED`** agora lista os jobs que estavam em execução (`affectedJobs`).

## 4. Exactly-once, lease e cancelamento

- **Append exactly-once:** a marca `cw_internal.applied_uploads` (no banco de destino, fora dos datasets) é gravada na mesma transação do INSERT; a retentativa de um append já aplicado só reconcilia os metadados (não duplica).
- **Staging nunca é reaproveitada** no import para SQL Server: a de uma tentativa que morreu no meio fica com parte das linhas e nada prova que está completa. Recarregar custa tempo; publicar incompleto custa o dado.
- **Lease do lock de import:** 120 s renovado a cada 30 s (antes TTL fixo de 30 min sem renovação). Dono vivo nunca perde a trava; dono morto bloqueia no máximo o lease; SIGTERM libera na hora e devolve a tentativa. Um import que perdeu o lease aborta antes de publicar (`LeaseLostError`).
- **Cancelamento cooperativo:** um job cancelado enquanto importa aborta antes do swap (`JobCancelledError`); `fail()` e a conclusão do job só agem se ele ainda está `RUNNING`.
- **Tipos só alargam:** append/upsert em tabela existente recusam estreitar coluna (DECIMAL em BIGINT arredondava; DATETIME em DATE perdia a hora).
- **Chave nula no upsert** é recusada; **arquivo sem colunas** vira upload `FAILED` com motivo; `deltaJson` sem `phase2` é recusado.
- **Colisão de nome** (`Obras.csv` × `obras.csv` = mesma tabela): o upload responde com um aviso em `meta.warnings`.

## 5. Fuso

Processo web, worker e supervisor rodam em **UTC** (`TZ=UTC` no Dockerfile, `ensureUtcTimezone()`), e a origem Postgres devolve datas como texto cru: valores e marca d'água nunca dependem do fuso do host.

## 6. Operação

- Migration aditiva `202609200004_load_ledger` (nenhuma carga depende dela).
- Trocas de tabela no Postgres usam `lock_timeout` de 3 s com retentativa (um leitor longo não trava mais todos os leitores).
- Índice em `cw_synced_at` criado antes do swap (consumo `rows?since=`).
- Retenção de jobs e auditoria apaga em lotes de 20 mil linhas.

## 7. Fontes conectadas: opções por fonte, guarda de queda e delta

- **Sem migração:** as opções por fonte vivem em `cw_system_settings` (`source.options.<id>` = JSON `{ allowEmpty, maxDropPct, onInvalid, strict }`; `source.run.<id>` = marca de uso único da próxima rodada). Alteradas por `PATCH /api/v1/dataset-sources/:id` (`options`, auditado).
- **Fonte legada** (sem registro de opções): valor irrepresentável (infinity, data BC) vira NULL com aviso `INVALID_VALUES_NULLED`; decimal de ponto flutuante com mais de 15 dígitos é arredondado com aviso `LEGACY_PRECISION`. **Fonte nova** grava `strict` + `onInvalid: "fail"` e falha a carga nesses casos.
- **Guarda de queda/vazio (fonte de tabela sem chave ou reconciliação):** agendada e sem override = protegida (FAILED). Atualização **manual** (`POST /dataset-sources/:id/refresh`) não é agendada: queda grande só marca SUSPECT; esvaziar exige `acceptDrop: true` (auditado). Consulta com janela e sem chave nunca é barrada (publica e marca SUSPECT). A reconciliação enfileirada pela escalada de verificações ignoradas pode apagar o que a verificação de chaves já mediu (+2 pontos).
- **Delta:** o incremental não lê linhas de delta NULL (só a 1ª carga e a reconciliação); uma linha nova que nasce com delta NULL chega na próxima reconciliação. O merge só preserva `cw_synced_at` de linha inalterada quando a tabela tem a coluna `_cw_rh` (hash); sem ela, toda linha lida é re-carimbada.
- **Reconciliação padrão** de fonte nova é espalhada por hash do id (minuto 0-59, hora 1-5 UTC).
