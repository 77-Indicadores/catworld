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
| Jobs pesados, syncs por storage, pausa entre lotes | Configurações > Worker (globais) | em até 10 s |
| Limites de upload (geral e Excel) | Configurações > Worker | próximo envio |
| Prazo do reinício seguro, espera máxima após falha | Configurações > Worker | próximo ciclo do supervisor |
| `CATWORLD_DATABASE_URL`, `CATWORLD_ENCRYPTION_KEY`, `AUTH_SECRET`, `CATWORLD_UPLOAD_DIR`, `CATWORLD_PUBLIC_ORIGIN` | ambiente | no boot (infraestrutura e segredos; precisam existir antes de o banco estar acessível) |

Sem valor salvo, vale o **padrão do código** (nunca uma env). As envs antigas (`CATWORLD_WORKER_ID`, `_WORKER_CONCURRENCY`, `_WORKER_JOB_TYPES`, `_JOB_POLL_MS`, `_DUCKDB_MEMORY_LIMIT`, `_IMPORT_BATCH_DELAY_MS`, `_MAX_HEAVY_JOBS`, `_MAX_SYNCS_PER_STORAGE`, `_UPLOAD_MAX_BYTES`, `_XLSX_MAX_BYTES`) são **ignoradas**; se estiverem no ambiente, um aviso no boot lista o nome e o valor de cada uma.

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

`GET /api/v1/workers` (perfis + estado + jobs rodando/na fila), `GET/POST /api/v1/worker-profiles`, `GET/PATCH/DELETE /api/v1/worker-profiles/:id` (PATCH devolve `meta.restartRequired`; DELETE com o processo rodando = 409 `PROFILE_RUNNING`), `GET/POST /api/v1/system/commands`, `GET/DELETE /api/v1/system/commands/:id` (cancela pendente), `GET/PATCH /api/v1/settings/worker` (globais e limites).

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
