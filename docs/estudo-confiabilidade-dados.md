# Estudo de confiabilidade dos dados e desempenho do Catworld

Data: 2026-09-20 · Escopo: caminho completo do dado (ingestão → armazenamento → entrega) · Status: estudo e auditoria; **nenhum item abaixo foi corrigido além dos três hotfixes citados na seção 3.**

## 1. Resumo executivo

**Requisito máximo:** o Catworld nunca pode entregar um dado errado por causa da ferramenta. Dado que já veio errado da origem é registrado como recebido; perda, arredondamento, duplicação, deslocamento de fuso, linha "fantasma" ou tabela incompleta introduzidos por nós são defeitos críticos.

**Resultado:** o requisito **não é atendido hoje**. Cinco frentes independentes (ingestão e tipos, motor de import, fontes conectadas, camada de consulta/entrega, desempenho e observabilidade) reproduziram, em Postgres real, **54 achados S0** (dado errado, faltando, duplicado ou obsoleto entregue sem erro; conto aqui os 4 marcados S0/S1 pelos pesquisadores). Vários são a mesma causa vista de ângulos diferentes; a seção 6 os reduz a **8 causas-raiz**.

Os dez riscos de maior impacto, na ordem que eu corrigiria:

| # | Risco | Efeito | Prova |
|---|---|---|---|
| 1 | Nada compara "linhas esperadas" com "linhas gravadas" (OBS-01) | Import incompleto sai `COMPLETED`. Aconteceu em produção: 50k, 300k, 600k, 650k de 828.672 | incidente + código |
| 2 | Append repetido em retentativa (MOT-01) | Linhas duplicadas se o processo cai depois do COMMIT e antes dos metadados | kill -9 em PG |
| 3 | Trava de import de 30 min sem renovação (MOT-02) | Um import apaga em silêncio o trabalho do outro | PG |
| 4 | Filtro de linhas excluídas "falha aberto" (ENT-01, FON-09) | 20% das consultas plausíveis devolvem linhas excluídas; tabelas derivadas as gravam para sempre | PG + verificado por mim |
| 5 | Conversão numérica via `parseFloat` e `NUMERIC(18,4)` fixo (TIP-01, FON-04, OBS-04) | Arredonda, perde precisão ou vira NULL sem aviso | PG |
| 6 | Leitura de CSV com dialeto próprio do DuckDB (TIP-04) e sniff de encoding em 64 KB (TIP-03) | Colunas descartadas, cabeçalho virando dado, mojibake | PG |
| 7 | Fonte incremental congela com um valor futuro (FON-01) e perde empates/NULL (FON-02) | Fonte "completed" e desatualizada para sempre | pipeline real |
| 8 | Vazio é sucesso (MOT-13, FON-05, OBS-05) | Upload vazio ou fonte sem linhas troca a tabela por 0 linhas | PG |
| 9 | Protocolo `rows?since=` (ENT-05) | Repete linhas para sempre, perde linhas por fuso e por ordem de commit | PG |
| 10 | Paginação por OFFSET com ordenação não única (ENT-03) | Até 10,4% das linhas duplicadas e 10,6% nunca entregues | PG |

**O que já foi corrigido (seção 3):** três hotfixes publicados em 2026-09-20 fecham o incidente da ADL (retentativa que reaproveita staging parcial no SQL Server), a perda silenciosa de linhas na leitura de CSV e a regressão de append/upsert em Postgres.

**Convenção de leitura das provas:** **PROVADO** = reproduzido por experimento com dados concretos (script guardado); **CÓDIGO** = demonstrado pela leitura, com arquivo:linha; **INFERIDO** = deduzido, não medido. Tudo que envolve SQL Server é CÓDIGO ou INFERIDO, porque não havia instância local.

## 2. Método e limites

- Cinco pesquisadores rodaram experimentos **somente** contra um Postgres 16 descartável local (`127.0.0.1:55433`), com o código real (`previewFile`, `rowsFromFile`, `importUploadPg`, `refreshDatasetSource`, `translateTsql`, `executeReadOnlyPg`), comparando o resultado com um oráculo independente (gerador do arquivo, fingerprint md5, tabela do "ERP"). Nenhum tocou produção nem o `.env`.
- Eu levantei a produção **apenas com leitura** (auditoria, versões de tabela, jobs, fontes) e verifiquei de forma independente a afirmação central de ENT-01 (o filtro de excluídas não é aplicado em 4 de 5 construções comuns).
- Ambiente de benchmark: Postgres em Windows, configuração padrão, disco quase cheio: use as **proporções** entre fases, não os segundos absolutos. Ruído de até 2x entre execuções.
- **Limites:** o caminho SQL Server (importer, mssql-storage, TDS) não pôde ser executado; as conclusões dele são CÓDIGO/INFERIDO. Os testes dos pesquisadores estão em `scratchpad/audit-*`; antes de corrigir cada item, ele deve virar um teste dentro do repositório (seção 8).
- Esforços na seção 7 (P/M/G) são minha estimativa, não medição.

## 3. O que já foi entregue

| Commit | Correção | Efeito |
|---|---|---|
| `f77d857` | A guarda contra staging parcial passa a valer também no "replace por diferença" (tabelas com `_cw_rh`) | Retentativa não troca a tabela por carga incompleta (incidente ADL) |
| `d99d6c7` | Pré-voo `count(*)` no DuckDB; erro após a 1ª linha é fatal; trava final entregue×contado | Leitura de CSV nunca perde linhas em silêncio (custo medido ~3%) |
| `3b72780` | Compatibilidade de schema ignora `cw_synced_at`/`cw_deleted_at` no import para Postgres; 10 testes de atomicidade contra PG real | Append/upsert em tabela existente voltam a funcionar |

**Lacuna conhecida desses hotfixes:** o mesmo ajuste de colunas internas **não** foi aplicado ao importer de SQL Server (MOT-12), e a guarda de staging ainda não cobre `phase2` nem `knownRowCount == 0` (MOT-05, MOT-09). Correção do SQL Server só foi validada por teste unitário.

## 4. Evidência de produção (somente leitura)

- **Vendas completo (ADL, SQL Server):** 4 janelas de dados incompletos nas últimas ~26 h (300k, 600k, 650k e 50k linhas), cerca de **7 h** servidas incompletas. Todas as 5 cargas truncadas de `vendas_completo` foram 2ª/3ª tentativa; a auditoria registrou `importMethod=idempotent-retry` com `rows < previewRows` e `success=true`.
- **Linha do tempo dos 50k:** tentativa 1 começou 20:18:52 UTC num container, o container foi trocado ~20:21 (um `WORKER_CRASHED` no mesmo minuto), a tentativa 2 esperou a trava de 30 min do processo morto até 20:49 e então trocou a tabela pela staging com 50 mil linhas.
- **Outros projetos:** 71 retentativas de import com reaproveitamento de carga em 30 dias, **57 com menos linhas que o arquivo**; 30 tabelas cujo último upload gravou menos linhas que o arquivo (TMK cp_rateado 83.968 de 348.666, insumos_comprados 26.624 de 131.967, Thunder vendas 36.864 de 47.783, Veratto cp_rateado 45.056 de 49.022…). Os valores em múltiplos de 1.024/2.048 que não mudam enquanto o arquivo cresce são a assinatura da leitura de CSV que parava sem erro.
- **Histórico "piscando":** 10 tabelas com queda >25% seguida de recuperação; ~233 h somadas servindo dado incompleto nas versões retidas (só há as últimas 10 versões).
- **Colisão de nome de arquivo:** `Obras.csv` e `obras.csv` viram a mesma tabela `obras` no TMK e se substituem mutuamente (214 ↔ 390.402 linhas).
- **Upload vazio:** um replace com 0 linhas foi aceito (Veratto `insumos_comprados`).
- **Workers:** 54 `WORKER_CRASHED`, todos código 3 (conflito de identidade), todos depois do supervisor entrar (19/09 21:26). 1,9% dos imports precisaram de mais de uma tentativa; há jobs com 15 a 21 tentativas.
- **Não é problema hoje:** nenhuma fonte extract atrasada; nenhum job `FAILED` retido em 30 dias.
- **Limite:** o último upload de uma tabela pode já ter sido corrigido por outro posterior; a lista mostra onde o estado atual *parece* incompleto, não garante o erro. As 20+ tabelas `livros_fiscais_*` com diferença constante de 777 linhas não têm causa determinada (pode ser divergência de contagem do preview).

## 5. Achados por área

Severidade: **S0** = dado errado, faltando, duplicado ou obsoleto entregue; **S1** = falha alta ou job travado; **S2** = robustez/desempenho.

### 5.1 Ingestão e fidelidade de valores (TIP)
| ID | Sev | Achado | Prova |
|---|---|---|---|
| TIP-01 | S0 | Toda coluna decimal vira `DECIMAL(18,4)`: escala >4 arredonda (`0.000123`→`0.0001`), 15+ dígitos viram NULL, tudo passa por `Number` | PROVADO PG; MSSQL função real |
| TIP-02 | S0 | Milhar/decimal ambíguo: `1,234` guardado como 1,234 (erro de 1000x); `2.500` como 2,5 | PROVADO |
| TIP-03 | S0 | Encoding detectado só nos primeiros 64 KB: UTF-8 válido vira mojibake; win-1252 tardio vira U+FFFD | PROVADO |
| TIP-04 | S0 | DuckDB refaz o dialeto sozinho: coluna descartada, cabeçalho numérico vira dado, aspas simples removidas; ninguém compara com o preview | PROVADO |
| TIP-05 | S0 | Append/upsert compara só nomes: DECIMAL em BIGINT arredonda, DATETIME em DATE trunca | PROVADO |
| TIP-06 | S0 | Override de tipo vira NULL em silêncio; `DECIMAL(p,s)` é só cosmético; overrides inválidos ignorados | PROVADO |
| TIP-07 | S0 | Linhas com campos a mais perdem células; fim de linha misto funde registros | PROVADO |
| TIP-08 | S0 | XLSX: rich text vira NULL, célula de erro vira `[object Object]`, data de fórmula vira string do fuso do host, só a 1ª planilha, linhas fantasma | PROVADO |
| TIP-09 | S0 | MSSQL TDS: BIGINT negativo vira NULL; BIGINT >2^53 perde precisão; datetime sem fuso passa pelo fuso local | FUNÇÃO REAL; ponta a ponta INFERIDO |
| TIP-10 | S0 | Texto é aparado; `""`/espaços viram NULL; bytes NUL removidos | PROVADO |
| TIP-11 | S0 | Datas: dd/mm × mm/dd decidido por valor; offset ISO descartado no PG mas aplicado no MSSQL | PROVADO |
| TIP-12 | S0 | Coluna do usuário chamada `cw_deleted_at`/`cw_synced_at` colide com as internas | PROVADO |
| TIP-13 | S0 baixo | `-007` vira -7 | PROVADO |
| TIP-14..19 | S1/S2 | Falha após o swap deixa tabela nova publicada com job FAILED; TIME sem faixa (`25:00`) derruba o job; colisão de cabeçalhos e limite de 63 bytes; UTF-16; linha `sep=;`; delimitador do hash `_cw_rh` | PROVADO |

### 5.2 Motor de import e ciclo de vida dos jobs (MOT)
| ID | Sev | Achado | Prova |
|---|---|---|---|
| MOT-01 | S0 | **Append reaplicado** em retentativa ou execução dupla (50.000 → 80.000; 3.000 ids duplicados) | PROVADO PG |
| MOT-02 | S0 | Trava de 30 min sem renovação: outro import assume com o dono vivo e um apaga o trabalho do outro | PROVADO PG |
| MOT-03 | S0 | Upsert estreita tipo de coluna e arredonda linhas antigas (1,5→2; hora perdida) | PROVADO PG |
| MOT-04 | S0 | Upsert com chave NULL insere uma linha a mais a cada execução | PROVADO PG |
| MOT-05 | S0 | MSSQL `phase2` confia em staging parcial (a guarda o exclui) | INFERIDO (alto) |
| MOT-06 | S0 | `deltaJson` sem `deltaReplace` vira replace completo com arquivo só da diferença; sem versão-base | INFERIDO (alto) |
| MOT-07 | S0/S1 | `fullSnapshot` com arquivo vazio/truncado esconde 100% das linhas (sem guarda de proporção) | PROVADO PG |
| MOT-08 | S0/S1 | Cancelar não interrompe import em curso; `fail()` ressuscita job cancelado | INFERIDO (alto) |
| MOT-09 | S0 baixo | Staging MSSQL sem token de dono (arquivo/mapeamento diferentes reaproveitados) | INFERIDO |
| MOT-10 | S1 | Dono morto segura a trava 30 min; cada reinício gasta 1 de 5 tentativas; deploy sempre mata import >10 min | PROVADO (trava) |
| MOT-11 | S1 | Queda entre swap e metadados deixa `row_count`, colunas e versões defasadas | PROVADO PG |
| MOT-12 | S1 | **Importer MSSQL não recebeu o ajuste das colunas internas** (append/upsert falham; delta-replace desligado) | INFERIDO (certo) |
| MOT-13 | S1 | Arquivo sem colunas: upload COMPLETED com 0 linhas, tabela intacta | PROVADO |
| MOT-14..25 | S1/S2 | Refresh de fonte em loop 409 após queda; guarda BUG6 ineficaz; `statement_timeout` de 10 min sem `lock_timeout`; staging órfã; índice duplicado; contadores errados; corrida no teto de jobs pesados | misto |

**Matriz de queda (kill -9) em PG:** nenhum leitor viu tabela parcial em nenhuma célula. Replace e upsert convergem após retentativa; **append é a única célula que duplica** (queda após COMMIT). Em todas as 17 células a trava ficou retida e staging/mgd ficaram órfãs.

### 5.3 Fontes conectadas (FON)
| ID | Sev | Achado | Prova |
|---|---|---|---|
| FON-01 | S0 | Um valor de incremento no futuro (2099) congela a fonte em silêncio, permanentemente | PROVADO |
| FON-02 | S0 | Empates na marca d'água, commits tardios e NULL no campo de incremento são perdidos | PROVADO |
| FON-03 | S0 latente | Fuso do processo ≠ UTC corrompe timestamps, datas e a marca d'água (nada fixa `TZ`) | PROVADO |
| FON-04 | S0 | Numéricos via `Number` em `NUMERIC(18,4)` (perde escala, 1e300/NaN viram NULL) | PROVADO |
| FON-05 | S0 | Leitura vazia da origem é sucesso (troca por 0 linhas; reconciliação sem guarda) | PROVADO |
| FON-06 | S0 | Detecção de exclusões vem desligada: fantasmas ficam vivos com status `completed` | PROVADO |
| FON-07 | S0 | Guarda de 30% deixa fantasmas para sempre com status `completed` | PROVADO |
| FON-08 | S0 | `PATCH` não zera `lastDeltaValue` (troca de coluna perde linhas) | PROVADO |
| FON-09 | S0 | Tabela derivada inclui linhas excluídas (materializa como dono, sem RLS) | PROVADO |
| FON-10 | S0 | Mapeamento de tipos altera valores (jsonb, bytea, interval, timestamptz sem fuso, microssegundos) | PROVADO |
| FON-11 | S0 | Coluna renomeada/removida na origem deixa linhas antigas NULL | PROVADO |
| FON-12 | S0/S1 | Falhas na verificação de chaves terminam `completed` só com aviso | PROVADO |
| FON-13 | S0 | Chaves numéricas arredondadas colidem entre execuções | PROVADO |
| FON-14..19 | S1/S2 | Nomes de coluna de delta/chave diferentes por maiúsculas; tipo mudou na origem; queda deixa "running"; MSSQL sem isolamento de snapshot; fome de fontes; sem listener `error` | misto |

### 5.4 Camada de consulta e entrega (ENT)
| ID | Sev | Achado | Prova |
|---|---|---|---|
| ENT-01 | S0 | Filtro de excluídas falha aberto: 18 de 89 consultas plausíveis passam sem filtro (`TRY_CAST`, `EXCEPT`, `LIKE…ESCAPE`, `ROLLUP`, `t.*`…); no SQL Server, ADMIN e `pg_isolation=off` não há RLS | PROVADO; **verificado por mim** |
| ENT-02 | S0 | CTE com nome de tabela é trocada pela tabela real quando há escopo (perde filtro do CTE e das excluídas) | PROVADO |
| ENT-03 | S0 | OFFSET com ordenação não única duplica e perde linhas sem aviso (31.332 duplicadas, 31.690 nunca entregues em 300k) | PROVADO |
| ENT-04 | S0 | Modo `fallback` traduz a consulta inteira pelo tradutor legado quando uma construção é rejeitada (LIKE vira sensível a caixa, mês=30 dias, ordem de NULL) | PROVADO |
| ENT-05 | S0 | `rows?since=`: (a) repete as mesmas linhas para sempre (ms×µs), (b) perde horas se o Node não está em UTC, (c) perde linha por ordem de commit, (d) baseline sem `since` corta em 1000 sem avisar, (e) `nextSince` rotulado `Z` mas em hora local do banco | PROVADO |
| ENT-06 | S0 | DATE/TIMESTAMP dependem do fuso do Node; microssegundos truncados; `infinity` vira null | PROVADO |
| ENT-07 | S0 | OData ignora `$filter`/`$orderby` que não entende e devolve a tabela toda (MSSQL ignora todos) | CÓDIGO + INFERIDO |
| ENT-08..14 | S0 | `CONVERT/CAST(VARCHAR(n))` ignora `n`; `LIKE '[a-c]'` e `\`; `TRY_CAST` numérico; `int + 'literal'` vira concatenação; `AVG(int)`; colação além do `=` (CHARINDEX, REPLACE, espaços); `DATEADD` | PROVADO PG; SQL Server por documentação |

Matriz diferencial: 70 construções T-SQL, com o resultado real no Postgres e o comportamento documentado do SQL Server (relatório do pesquisador, scratchpad `audit-delivery`).

### 5.5 Observabilidade e desempenho (OBS, PER)
| ID | Sev | Achado |
|---|---|---|
| OBS-01 | S0 | Carregado × **esperado** nunca é comparado; as verificações são autorreferentes (no MSSQL, em retentativa, `total` = contagem da staging, então o teste não pode falhar) |
| OBS-02 | S0 | O import para PG não grava auditoria nem estatísticas do parser |
| OBS-03 | S0 | `UPLOAD_IMPORT_PERF` sai `success=true` na mesma transação que marca COMPLETED: a evidência é gravada e o veredito nunca chega |
| OBS-04 | S0 | Valores alterados sem contador (DECIMAL via double, BIGINT/DATE inválidos viram NULL) |
| OBS-05 | S0 | Replace com 0 linhas ou queda grande é publicado, sem comparar com a versão anterior |
| OBS-06/07 | S1 | Frescor reflete estado do job, não o dado; `queued/running` nunca viram "Atrasada" |
| OBS-08..18 | S1/S2 | `WORKER_CRASHED` sem os jobs afetados; requeue silencioso; sem endpoint de integridade para o monitor; dois parsers que podem discordar; sem varredura de staging órfã; `parseMs` inclui o tempo do consumidor; evidências expiram em 30 dias |

**Desempenho (medido, PG local):** arquivo real 828.672×70 (450 MB) importa em **285,7 s** — parse 62 s (22%), conversão JS+md5 100 s (35%), INSERT 97 s (34%), índices 23 s (8%); pipeline totalmente serial. Os 20–48 min no SQL Server **não** vêm do pipeline compartilhado (~160 s dos 285 s); estão no lado TDS/MSSQL, que não foi medido.

| ID | Achado | Ganho estimado |
|---|---|---|
| PER-01 | Índice `_cw_rh` construído 2 vezes e sem uso no caminho PG | −12 a −23 s (até 8%); 3–5x por índice com `COLLATE "C"` |
| PER-02 | Pipeline serial (`await flushBatch` para o parse) | 285 s → ~170–190 s (INFERIDO); 1,74x com 4 conexões |
| PER-03 | Custo JS por célula (~1,7 µs, 58M células) | −30 a −50 s (INFERIDO) |
| PER-04 | Leitor longo bloqueia o swap **e** todo leitor novo (11,7 s e 11,4 s medidos); sem `lock_timeout` | apagão de minutos → ≤2 s por tentativa |
| PER-05 | Trava sem renovação (= MOT-02) | fecha a janela de import duplo |
| PER-07 | `rows?since=` sem índice em `cw_synced_at`: 190–340 ms contra 1–4 ms | ~100x por consulta do SDK |
| PER-08 | Preview refaz um parse completo em JS (~73 s a 828k×70) e com parser diferente | −60 s de CPU |
| PER-11 | Auditoria sem índice em usuário/token (0,7–9 s); DELETE de 1,5M linhas em 28,9 s; `DATA_READ` por requisição | remove picos |

`BATCH_SIZE` não é alavanca (500–20.000 dentro de ±40%); COPY dá 1,2–1,8x só do lado do banco e só com 60 colunas. Memória: RSS até ~820 MB por import (heap JS só ~180 MB): cada import concorrente soma ~0,5 GB.

## 6. Causas-raiz transversais

1. **Verificações autorreferentes.** O sistema conta o que carregou e compara com o que ele mesmo contou; o "esperado" (contagem do arquivo/da origem) nunca entra na decisão. (OBS-01/03/05, MOT-13, FON-05, e o incidente da ADL)
2. **Coagir em vez de falhar.** Conversão que vira NULL, arredonda ou trunca sem contador nem erro. (TIP-01/02/05/06/07/10/11, FON-04/10/13, MOT-03)
3. **Falha aberta.** Onde a proteção não consegue avaliar, o dado passa: filtro de excluídas, tabelas derivadas, `fallback` legado, `$filter` do OData, baseline sem `since`. (ENT-01/04/07, FON-09, ENT-05d)
4. **Efeitos sem marca de "já aplicado".** Append e metadados não são exactly-once; não há reconciliação de metadados com a tabela física. (MOT-01/11)
5. **Trava sem lease e job sem dono.** Trava de 30 min sem renovação, retentativas que gastam tentativas, cancelamento que não cancela, reinício que recoloca job com o dono vivo. (MOT-02/08/10, MOT-15, `WORKER_CRASHED`)
6. **Tempo e fuso.** Marca d'água e serialização dependem do fuso do processo e da precisão (ms×µs); sentinela futura congela fonte. (ENT-05/06, FON-01/02/03)
7. **Duas implementações que divergem.** Importers PG e MSSQL, tradutor novo e legado, parser de preview e de carga: cada divergência já causou bug (a correção da guarda e das colunas internas chegou só num lado). Sem testes de SQL Server.
8. **Observabilidade sem veredito.** A auditoria guarda os fatos e marca sucesso; o frescor vem do estado do job; o monitor só vê "o banco responde".

## 7. Plano de correção

Cada item deve nascer como teste que falha (harness em `importer-pg.reliability.pg.test.ts` e `parser-reliability.test.ts` serve de modelo).

**Fase 1: fechar as perdas silenciosas (S0 de correção pequena/média)**
1. **Invariante de completude** antes do swap, em PG e MSSQL: `parsed == esperado == staged`; abaixo do esperado = FAILED sem trocar a tabela; retentativa sem esperado conhecido = SUSPECT. (OBS-01, MOT-05/09) — M
2. **Guarda de vazio e de queda** contra a versão anterior (0 linhas bloqueia sem `allow_empty`; queda > X% bloqueia fonte agendada e marca upload como suspeito); mesma guarda em `fullSnapshot` e reconciliação. (OBS-05, MOT-07/13, FON-05/07) — M
3. **Marca exactly-once no destino** (`cw_applied_uploads`, gravada na mesma transação do append/swap) e `reconcileTableMeta` idempotente. (MOT-01/11) — M
4. **Lease renovado** de 90–120 s no lugar da trava de 30 min; liberar no SIGTERM devolvendo a tentativa; abortar o import quando a renovação falha. (MOT-02/10) — M
5. **Falhar fechado** no filtro de excluídas: se não consegue analisar a consulta, recusar (400), e tabelas derivadas falharem quando o filtro foi pulado; reaproveitar o pré-passe do `TRY_CAST`. (ENT-01, FON-09) — M
6. **Tipos:** stop `parseFloat`; inferir precisão/escala do arquivo inteiro ou usar texto; nunca gravar NULL para valor não vazio; append/upsert usam os tipos físicos e recusam estreitamento; recusar chave NULL. (TIP-01/05/06, MOT-03/04, FON-04) — G
7. **Leitura de CSV determinística:** passar delimitador/aspas/cabeçalho detectados ao DuckDB (`auto_detect=false`), validar UTF-8 no arquivo inteiro, e comparar `preview.rowCount` com o carregado. (TIP-03/04/07) — M
8. **Fuso:** fixar `TZ=UTC` no worker e na web; `types.setTypeParser` para as datas (1082/1114/1184) devolvendo texto; `SET TimeZone='UTC'`. (FON-03, ENT-06, ENT-05b) — P
9. **Importer MSSQL:** usar `userColumnNames` nos três pontos; corrigir BIGINT negativo/precisão e datetime em UTC; validar em CI com SQL Server. (MOT-12, TIP-09) — M

**Fase 2: contratos de entrega e fontes**
10. **Cursor `since`:** usar o texto do timestamp (µs), fixar UTC, janela de segurança com dedupe, baseline paginado com `hasMore`. (ENT-05) — M
11. **Paginação determinística:** desempate por todas as colunas/ctid ou cursor em `REPEATABLE READ`; avisar quando a ordenação não é única. (ENT-03) — M
12. **OData e `fallback`:** rejeitar (501/400) o que não entende; `fallback` sem semântica diferente ou com aviso explícito. (ENT-04/07) — M
13. **Fontes:** limitar marca d'água futura, janela de sobreposição, `PATCH` que zera o incremento, detectar mudança de schema e recarregar, promover exclusões por padrão para fontes com chave, escalar `KEYS_CHECK_*` persistente. (FON-01/02/06/07/08/11/12) — G
14. **Cancelamento e token de tentativa:** escritas condicionadas a `status='RUNNING' AND attempt_token=?`, cancelamento cooperativo. (MOT-08/15) — M
15. **Reservar nomes internos** (`cw_*`, `_cw_rh`) e limitar identificadores ao limite do provedor; alertar colisão de nome de tabela por caixa (`Obras`/`obras`). (TIP-12/16, colisão em produção) — P
16. **Traduzir/documentar** as diferenças T-SQL restantes (matriz de 70 casos). (ENT-08..14) — M

**Fase 3: observabilidade e desempenho**
17. **Livro de integridade** `cw_load_ledger` (esperado, lido, staging, físico, anterior, parser, retentativa, nulos por conversão, checksum, veredito) gravado na mesma transação da carga, também em PG. — M
18. **Estado "possivelmente incompleta"** no frescor e no dashboard; `GET /api/health/integrity` para o monitor; evento `DATA_INTEGRITY_SUSPECT`; `WORKER_CRASHED` listando jobs afetados. — M
19. **Desempenho:** índice `_cw_rh` único e com `COLLATE "C"`, pipeline com sobreposição e conversores por coluna, índice `(cw_synced_at, chave)`, `lock_timeout` no swap, medir as fases do SQL Server. — G
20. **Investigar as trocas de container/`WORKER_CRASHED`** (hipótese mais provável: queda da conexão do lock do supervisor derrubando o contêiner; conferir no log do supervisor) e fazer o supervisor reobter o lock em vez de sair. — M

## 8. Estratégia de testes e convenções

- **Invariantes como código:** cada carga verifica completude, unicidade de chave, contagem física × registrada, e o teste de integração falha se o veredito for pior que OK.
- **Oráculo independente** em todo teste de fidelidade (gerador do arquivo, fingerprint md5), nunca o próprio parser.
- **Matriz de fuso:** rodar a suíte de datas/marca d'água com `TZ` em UTC, Asia/Tokyo e America/Sao_Paulo.
- **Harness de queda:** `kill -9` do processo de import em cada ponto (carga, índice, swap, metadados) e verificação do estado final (modelo em `audit-engine/crash-matrix.ts`).
- **Teste diferencial T-SQL × Postgres** com a matriz de 70 construções, marcando o que é executado e o que é só documentação.
- **SQL Server em CI** (contêiner) para importer, storage e TDS: hoje o caminho de produção mais crítico não tem teste ponta a ponta.
- **Convenção de falha:** proibir `catch` que engole erro em caminho de dados sem contador (hoje há ~55 pontos) e revisar cada um; falha de conversão é erro, nunca NULL.
- **Uma implementação, não duas:** extrair a lógica comum dos importers PG e MSSQL (decisões de staging, guardas, integridade) para um módulo único testado.
- **Cobertura:** `worker/index.ts` (laço de jobs, 773 linhas), `import-lock.ts`, `mssql-storage.ts` e os conectores não têm teste próprio.

## 9. O que foi verificado seguro

- Inferência de tipo usa o arquivo inteiro (não a amostra); códigos com zero à esquerda, BIGINT ±2^63 e notação científica ficam como texto exato; CSV com quebras de linha, BOM, CRLF, duplicatas, cabeçalhos vazios/duplicados.
- Postgres: nenhum leitor viu tabela parcial em nenhuma queda; replace/upsert convergem; upsert recusa chave duplicada; RLS é reaplicada a cada swap; dupla execução de replace/upsert é idempotente.
- Fontes: falha no meio do stream mantém o destino intacto; marca d'água só avança depois do swap; lock NOT_RUNNING impede execução concorrente da mesma fonte; leitores em merge não viram estado parcial (4.342 leituras).
- Entrega: filtro de excluídas correto quando a consulta é analisada (aliases, subconsultas, CTEs, APPLY, janelas, UNION); RLS/papéis escondem excluídas mesmo quando o filtro pula; bigint/decimal exatos como texto; `truncated` correto; exportação PG em `REPEATABLE READ` sem duplicar; OData escapa valores e checa acesso.

## 10. Limitações e próximos passos de pesquisa

- **SQL Server:** todos os achados MSSQL são CÓDIGO/INFERIDO. Prioridade: um teste ponta a ponta com BIGINT negativo, BIGINT >2^53, datetime sem fuso e a retentativa.
- **Produção:** o fuso real do worker (não há `TZ` no Dockerfile), a causa exata das trocas de container e o log do supervisor.
- **Não medido:** o tempo por fase do import para SQL Server; XLSX real com estilos; gravações concorrentes de outra rota entre o merge e o swap.
- **Provas dos pesquisadores:** guardadas em `scratchpad/audit-types`, `audit-engine`, `audit-sources`, `audit-delivery`, `audit-perf`; devem ser convertidas em testes do repositório antes de cada correção.

## 11. Artefatos

- Auditoria de produção: `scratchpad/prod-study.ts`, `prod-study2.ts`, `impact.ts`, `t50.ts`.
- Provas de campo: `scratchpad/spot1.ts` (ENT-01).
- Testes já entregues: `parser-reliability.test.ts` (30), `importer-pg.reliability.pg.test.ts` (10), `staging-guard.test.ts`.

## 12. Status da implementação (branch `hardening/data-reliability`, local, sem push)

Verificação da branch: `tsc` limpo e suíte completa verde contra Postgres 16 e **SQL Server 2022 reais** (`CW_TEST_PG_URL` e `CW_TEST_MSSQL_URL`); rodando todos os arquivos em paralelo alguns testes de banco estouram timeout por contenção, mas passam isolados (`--no-file-parallelism` para uploads e storage). Cada correção nasceu com teste; os de integridade e atomicidade foram conferidos falhando no código antigo.

**Rodada de revisão independente (3 revisões + testes em SQL Server real).** Achados corrigidos e integrados: paginação OData sem `$top` cortava em 10 mil linhas; `bulkInsert` do SQL Server arredondava DECIMAL largo e BIGINT >2^53 (agora exato, provado no SQL Server real); índice `cw_synced_at` só a cada duas cargas; guarda de queda/vazio sem exceção para refresh manual; append/upsert em tabela existente caindo para TEXT com data/decimal ambíguos (agora herda o tipo e a convenção); barra de integridade confiando em `rowCount` do cliente; exactly-once faltando no append que cria a tabela; erros determinísticos reententados 5×; `STRING_AGG`/`TRANSLATE` rejeitados sem motivo; `changes()` do SDK descartando linhas idênticas; e outros (ver `git log`). Dois bugs reais só apareceram no SQL Server real (colunas `cw_*` no merge legado; DECIMAL de 18 dígitos).

**Produção (somente leitura, 21/09):** os três hotfixes de 20/09 (staging parcial, leitura de CSV, append PG) coincidem com zero casos de "gravou menos que o arquivo" (114 cargas concluídas depois, 5 com mais de 100 mil linhas), contra 4 a 11 casos por dia antes. Amostra curta: o veredicto exige o dia completo, incluindo `vendas_completo` e as tabelas do TMK.

**Achado novo, ainda não corrigido em produção:** o worker sai com código 3 ("identidade em uso") logo depois de o contêiner reiniciar, porque a pulsação do processo antigo (PIDs reaproveitados) ainda está fresca (45 s). Com reinícios seguidos isso esgota o limite de reinício ("Restart limit reached"). Correção candidata: o supervisor, que já detém o advisory lock, não deve ser bloqueado pela pulsação de processo anterior do mesmo contêiner.

| Item do plano | Situação | Onde |
|---|---|---|
| 1 Completude carregado × esperado | **Feito** (PG e SQL Server) | `integrity/policy.ts`, importers |
| 2 Guarda de vazio e de queda | **Feito** em uploads e fontes | importers, `sources.ts` |
| 3 Append exactly-once + reconciliação | **Feito** | `applied-marker.ts`, importers |
| 4 Lease do lock de import | **Feito** | `db/import-lock.ts`, worker (SIGTERM libera e devolve a tentativa) |
| 5 Filtro de excluídas falha fechado; derivadas | **Adiado** (arquivos do dono): patch e protótipo testado em `docs/deferred-patches/` | ENT-01, FON-09 |
| 6 Tipos e conversão | **Feito** (decimal exato por coluna, sem NULL silencioso, sem estreitar) | TIP-01..13,15,16; MOT-03/04 |
| 7 Leitura de CSV determinística | **Feito** | encoding no arquivo inteiro, dialeto explícito no DuckDB |
| 8 Fuso UTC | **Feito** | `TZ=UTC`, `ensureUtcTimezone`, datas como texto cru |
| 9 Importer SQL Server | **Feito no código** (colunas internas, tipos que só alargam, BIGINT/datas em UTC); **não testado em SQL Server real** | `importer.ts` |
| 10 Cursor `since` | **Parcial**: biblioteca entregue e testada; a rota está no patch adiado | `since.ts`, `deferred/ent-05-route.md`, SDK |
| 11 Paginação determinística | **Feito** no Postgres (o OFFSET do SQL Server não foi alterado) | `storage/paging.ts`, SDK usa stream |
| 12 OData e `fallback` | OData **feito**; `fallback` (ENT-04) **adiado** (patch pronto) | `odata/*` |
| 13 Fontes | **Feito** (marca d'água, janela, guardas, mudança de estrutura, escalada, lease, PATCH) | `connections/*` |
| 14 Estado guardado e cancelamento | **Feito** | worker, `db/job-cancel.ts` |
| 15 Nomes reservados e colisões | **Feito** (`cw_*`, 63 bytes, aviso de colisão `Obras.csv`/`obras.csv`) | `naming.ts`, `name-collision.ts` |
| 16 Diferenças T-SQL × Postgres | **Feito** (emulado ou rejeitado); mudanças em `docs/sql-contract-changes.md` | `translate.ts` |
| 17 Livro de integridade | **Feito** | `cw_load_ledger`, `integrity/ledger.ts` |
| 18 "Possivelmente incompleta" e monitor | **Feito** | dashboard, `GET /api/health/integrity`, `WORKER_CRASHED` com jobs afetados |
| 19 Desempenho | **Feito**: um índice `_cw_rh`, pipeline com sobreposição, índice `cw_synced_at`, `lock_timeout` no swap, DELETE em lotes. Import 100k×60 a 26 s → 18 s na mesma máquina (A/B alternado). Falta medir o lado SQL Server. | `importer-pg.ts`, `pg-storage.ts` |
| 20 Trocas de contêiner (`WORKER_CRASHED`) | **Mitigado**: o supervisor retoma o lock em vez de sair; causa exata ainda a confirmar no log de produção | `supervisor/*` |

### Decisões do dono antes de publicar

1. **Modo da barra de integridade.** O padrão é `enforce`: cargas que hoje publicam com linhas faltando passam a **falhar** e a tabela anterior fica. Sugestão: publicar com `mode=warn` (`PATCH /api/v1/settings/integrity`), observar `GET /api/health/integrity` por alguns dias e então ligar `enforce`.
2. **Arquivos e colunas que antes "funcionavam" com dado errado agora falham ou viram TEXT:** linha com campos a mais que o cabeçalho, coluna decimal/data ambígua (`1,234`, `04/05/2026`), offsets de fuso diferentes de UTC, XLSX com dados em várias abas, bytes inválidos em Windows-1252, valores fora do tipo mapeado.
3. **SQL Server:** DECIMAL com mais de 15 dígitos significativos agora entra exato (staging em texto + `ALTER COLUMN`), mais lento nessas colunas; fontes existentes com mapeamento antigo mantêm a coluna `DECIMAL(18,4)` e arredondam a 4 casas.
4. **Fontes:** novas fontes com chave ganham reconciliação diária por padrão (leitura completa: pesada em ERPs grandes); float/numeric sem restrição viram TEXT em fontes novas; fontes existentes que precisam alargar tipo fazem uma recarga única.
5. **Traduções T-SQL:** `LIKE` com `[a-c]`, `CONVERT(VARCHAR(n))` truncando, `CHARINDEX`/`REPLACE` sem diferenciar caixa e `coluna + '5'` rejeitado como ambíguo mudam o resultado de consultas existentes; `AVG(int)` truncado só sob opção.
6. **OData e export:** filtro/ordenação não suportados agora dão 400/501 (antes devolviam a tabela toda); CSV com `dateFormat=iso` por padrão e uma linha final `# RESULTADO TRUNCADO` quando cortado.
7. **Aplicar os patches adiados** (`docs/deferred-patches/`) depois de commitar o trabalho em andamento em `hide-deleted*`, `apply.ts`, `run.ts`, `derived.ts`, rota `rows` e `docs/sql-contract.md`.

### O que continua em aberto

- Testes em SQL Server real agora existem para `kill -9` no meio do import com retentativa (replace, append exactly-once e delta-replace) e para `refreshDatasetSource` de fonte Postgres para storage SQL Server (valores exatos, incremental, reconciliação, bloqueio de fonte vazia). Nenhum revelou defeito.
- Os patches de `docs/deferred-patches/` (ENT-01, ENT-04, ENT-05, FON-09) foram **aplicados na árvore de trabalho** por cima do trabalho em andamento do dono, com testes em Postgres real, e aguardam o commit do dono (não foram commitados para não misturar com o trabalho dele).
- Confirmar no log do supervisor de produção a causa das quedas de conexão do lock e o horário.
- Não houve otimização do import específico do SQL Server (20 a 48 min): falta medir por fase.
- Correções de comportamento como `TIP-10` (não aparar texto, `""` ≠ NULL) e o hash `_cw_rh` **não foram alteradas** de propósito (mudariam chaves e deltas já gravados).
