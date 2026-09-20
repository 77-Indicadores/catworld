# Arquitetura dos workers

Os workers **não usam variáveis de ambiente para configuração**: tudo é editado em *Configurações > Worker* e guardado no banco. Um **supervisor** lê essa configuração, sobe os processos e executa os comandos da tela.

```
 Tela (ADMIN) ──API──▶ cw_worker_profiles / cw_system_commands ◀──lê── Supervisor ──fork──▶ worker "worker-uploads"
                                                                        (container `workers`)            └────▶ worker "worker-sync"
```

## Peças

| Peça | Onde | Papel |
|---|---|---|
| Perfil de worker | tabela `cw_worker_profiles` | Um processo: nome, tipos de job, paralelismo, intervalo de busca, memória do DuckDB, habilitado. Editado na tela. |
| Supervisor | `src/supervisor/` (`npm run supervisor`, container `workers`) | Sobe um processo por perfil habilitado, reinicia o que cair (backoff 1 s, 2 s, 4 s… até o teto), executa comandos. Um só ativo por banco (advisory lock); o segundo fica em standby. |
| Worker | `src/worker/index.ts --profile <nome>` | Pega jobs da fila. Identidade e config vêm do perfil. |
| Comandos | tabela `cw_system_commands` | Reiniciar (seguro/agora), parar, iniciar; só a API de ADMIN cria. |
| Estado observado | `cw_supervisor_state`, `worker.liveness.*` | Heartbeat do supervisor e dos workers (lido pela tela e pelo healthcheck). |

## Configuração: onde fica cada coisa

| O quê | Onde | Vale |
|---|---|---|
| Tipos de job, paralelismo | perfil (tela Workers) | após reiniciar o worker ("reinício pendente") |
| Intervalo de busca, memória do DuckDB, habilitado | perfil | em até 10 s |
| Perfil de desempenho (slots dos workers padrão + tetos + pausa) | Configurações > Worker (topo); ver *Perfis de desempenho* | tetos em até 10 s; slots após reiniciar |
| Teto de jobs pesados, leituras por storage, pausa entre lotes, memória do container (só aviso) | Configurações > Worker > Personalizar > Proteções (globais) | em até 10 s |
| Limites de upload (geral e Excel) | Configurações > Worker | próximo envio |
| Prazo do reinício seguro, espera máxima após falha | Configurações > Worker | próximo ciclo do supervisor |
| `CATWORLD_DATABASE_URL`, `CATWORLD_ENCRYPTION_KEY`, `AUTH_SECRET`, `CATWORLD_UPLOAD_DIR`, `CATWORLD_PUBLIC_ORIGIN` | ambiente | no boot (infraestrutura e segredos; precisam existir antes de o banco estar acessível) |

Sem valor salvo, vale o **padrão do código** (nunca uma env). As envs antigas (`CATWORLD_WORKER_ID`, `_WORKER_CONCURRENCY`, `_WORKER_JOB_TYPES`, `_JOB_POLL_MS`, `_DUCKDB_MEMORY_LIMIT`, `_IMPORT_BATCH_DELAY_MS`, `_MAX_HEAVY_JOBS`, `_MAX_SYNCS_PER_STORAGE`, `_UPLOAD_MAX_BYTES`, `_XLSX_MAX_BYTES`) são **ignoradas**; se estiverem no ambiente, um aviso no boot lista o nome e o valor de cada uma.

## Perfis de desempenho (presets)

A tela abre com três perfis — **Econômico**, **Equilibrado** (recomendado) e **Alto desempenho** — mais **Personalizado** para quem quer ajustar cada número. Um perfil define, de uma vez, tudo o que a tela mostra:

| | Econômico | Equilibrado | Alto desempenho |
|---|---|---|---|
| Sync rápido (`worker-sync`) | 1 | 3 | 5 |
| Sync longo (`worker-sync-long`) | 1 | 1 | 2 |
| Uploads leves (`worker-uploads`) | 1 | 2 | 3 |
| Uploads pesados (`worker-uploads-heavy`) | 1 | 1 | 2 |
| Leituras simultâneas por storage | 1 | 2 | 4 |
| Teto de jobs pesados | 2 | 2 | 4 |
| Pausa entre lotes de import | 500 ms | 150 ms | 0 |

### Faixas (lanes)

Cada job tem um **peso** (0/1 leve, 2 pesado) e cada perfil de worker pode filtrar por peso (`cw_worker_profiles.weights`; vazio = todos, o comportamento antigo). Um preset liga quatro faixas: **sync rápido** (fontes e limpeza, pesos 0/1), **sync longo** (fontes longas e tabelas derivadas, peso 2), **uploads leves** e **uploads pesados**. Assim a incremental da ADL (minutos) não segura as fontes de segundos, e a prévia de um upload não espera um import de 20 min.

- **Classificação automática das fontes** (`classifySourceLane`, em `sources.ts`): reconciliação → longa; duração média (`avg_run_ms`, média móvel α=0,3 das execuções incrementais bem-sucedidas) ≥ 120 s → longa; senão `lastRowCount` ≥ 500 mil → longa; sem histórico, a regra antiga (limitada = rápida, sem limite = longa). Vale já no próximo enfileiramento.
- **Aplicar cria os perfis que faltam** (o supervisor sobe sozinho, sem reiniciar) e ajusta tipos/pesos/slots dos existentes (esses precisam reiniciar). A migration `202609200003_worker_lanes` é aditiva e dormente: sem aplicar um preset, nada muda.
- Em *Personalizar* (Workers) o perfil tem o campo **Cargas**: Todas / Só leves / Só pesadas. A API avisa quando algum par (tipo, peso) fica sem worker.

- **Sem estado escondido.** O perfil é só um rótulo *detectado* dos valores atuais (`detectPreset`, em `src/lib/worker-presets.ts`). Alterou qualquer número em "Personalizar", vira "Personalizado". Não há uma segunda fonte de verdade.
- **Slots x tetos.** O paralelismo real é o **menor** entre os slots do worker e os tetos globais. Antes, os presets só mexiam nos tetos e cada worker tinha 1 slot, então "Máximo" quase não mudava nada.
- **Regra de coerência.** `Teto de jobs pesados >=` soma dos slots das faixas pesadas: com o teto abaixo, as faixas pesadas rodam menos que o configurado. A tela avisa (não bloqueia).
- **Aplicar** (`POST /api/v1/settings/worker/preset`, ADMIN, auditado como `WORKER_PRESET_APPLIED`): as quatro faixas (cria as que faltam) + os três tetos, numa única transação. Não reinicia: a resposta traz `meta.restartProfiles` (existentes que mudaram) e `meta.newProfiles` (criados agora). A tela oferece *Salvar e reiniciar com segurança* (um `RESTART_PROFILE` SAFE por perfil que mudou) ou *Só salvar*. Os tetos valem em até 10 s; os slots, após reiniciar.
- **Estimativas.** Memória (típica e de pico) usa as RSS medidas em produção: ~1,5 GB (pico ~3,5 GB) por slot de upload (leve ou pesado) e ~0,25 GB (pico ~0,7 GB) por slot de sync, mais 0,5 GB de base. Informando o limite do container em *Proteções*, a tela avisa quando o pico estimado o ultrapassa.
- Os números dos perfis são **hipóteses** a validar com o limite de memória do container `workers` e a tolerância das ERPs.

## Reinício (estilo Jenkins)

| Ação | Como funciona |
|---|---|
| Reiniciar com segurança | O worker para de pegar jobs novos, termina os em andamento e sai; o supervisor sobe outro. Passado o prazo (padrão 10 min): SIGTERM, depois SIGKILL; os jobs voltam para a fila (consome uma tentativa) e o comando termina `FORCED`. |
| Reiniciar agora | SIGTERM imediato; os jobs em andamento voltam para a fila (`releaseSelf`). |
| Parar / Iniciar | Grava `enabled` no perfil e drena/sobe o processo. |
| Reiniciar todos / supervisor | Aplica a todos; reiniciar o supervisor drena tudo e sai (o Docker o levanta de novo). |

Estados do comando: `PENDING → ACCEPTED → DRAINING → APPLYING → DONE` (ou `FORCED`, `FAILED`, `CANCELLED`, `EXPIRED`). Pendente há mais de 1 h expira; comandos em andamento quando o supervisor morre viram `FAILED` (`supervisor_restart`). Um comando aberto por worker; sem supervisor vivo a API responde `409 SUPERVISOR_NOT_RUNNING` (nada é enfileirado no vazio). Reiniciar a interface web **não** faz parte desta versão.

Segurança: só ADMIN cria comandos; `action`/`mode` são enums (zod + CHECK no banco); o supervisor mapeia cada ação para uma função fixa, nunca executa texto do banco; os tipos de job são validados contra a lista conhecida antes de chegar ao `claim`.

## API (ADMIN)

`GET /api/v1/workers` (perfis + estado + jobs rodando/na fila), `GET/POST /api/v1/worker-profiles`, `GET/PATCH/DELETE /api/v1/worker-profiles/:id` (PATCH devolve `meta.restartRequired`; DELETE com o processo rodando = 409 `PROFILE_RUNNING`), `GET/POST /api/v1/system/commands`, `GET/DELETE /api/v1/system/commands/:id` (cancela pendente), `GET/PATCH /api/v1/settings/worker` (globais e limites), `POST /api/v1/settings/worker/preset` (aplica um perfil de desempenho: `{ "preset": "economico" | "equilibrado" | "alto" }`; devolve `data.changes` e `meta.restartProfiles`).

## Migrando de `worker-uploads` / `worker-sync`

**Antes de atualizar**, anote os valores que você usava no ambiente dos containers antigos (paralelismo, intervalo, memória do DuckDB, limites de upload, jobs pesados) — o boot da nova versão os lista, mas a partir dela eles não valem mais.

1. Atualize a imagem e aplique as migrations (`npm run migrate`): cria os perfis `worker-uploads` (prévia e importação de upload) e `worker-sync` (atualização de fontes, tabelas derivadas **e limpeza diária**) e os limites de upload padrão.
2. Em *Configurações > Worker*, copie para a tela os valores anotados que sejam diferentes do padrão.
3. **Pare** os serviços `worker-uploads` e `worker-sync` antigos e suba o serviço `workers` do `docker-compose.example.yml`. Não rode os dois ao mesmo tempo: um worker se recusa a subir se já existe outro vivo com a mesma identidade, mas o ideal é não depender disso.
4. Remova as envs de worker do `.env`/Coolify.

O compose antigo **deixa de funcionar** (o worker exige `--profile` e não lê mais env): atualize o compose junto com a imagem.

Observação: o container `workers` divide um único limite de memória entre todos os perfis (antes cada container tinha o seu). Se usar `mem_limit`, some as necessidades dos perfis.

## Desenvolvimento

`npm run supervisor:dev` (lê o `.env`) sobe o supervisor; ou um worker avulso: `npm run worker -- --profile worker-uploads`. Sem supervisor, a tela avisa e desabilita o reinício (editar perfis continua funcionando).

## Testes

Unitários: validação de perfis (`server/worker/profiles.test.ts`), máquina de estados dos comandos (`commands.test.ts`), núcleo do supervisor com filhos e relógio falsos (`supervisor/core.test.ts`), runtime do worker e guarda de identidade (`worker/runtime.test.ts`), tela (`components/settings/workers-section.test.tsx`) e um teste de regressão que garante que nenhum código lê as envs removidas (`server/env.test.ts`).
