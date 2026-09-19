# Auditoria de UX/UI/Frontend — Catworld — Diagnóstico

Data: 2026-09-19. Este documento é o diagnóstico solicitado antes de qualquer
implementação (ver seção "Plano de implementação" para o que ainda depende de
decisão de produto). Baseado em leitura completa de código, docs, schema e
testes — não assume que a implementação atual representa a proposta correta
do produto.

---

## 1. Visão geral do produto

**Proposta:** Catworld é uma camada de catálogo, governança e acesso sobre
bancos SQL (Postgres/Azure SQL/SQL Server), voltada a times de dados que
precisam publicar datasets tabulares — via upload de arquivo, sincronização
de fonte externa ("extract"), consulta direta na origem ("live") ou tabela
derivada por SQL — e disponibilizá-los para consumo (frontend, API REST,
OData, SDK Python), sem que as aplicações consumidoras precisem de driver
SQL ou credenciais de banco.

**Perfis de usuário** (roles no `User.role`, string livre validada em
código — não há enum no schema):
- **ADMIN**: acesso irrestrito; único que pode excluir projeto/dataset e
  operar workers/sistema.
- **DATA_MANAGER**: na prática equiparado a ADMIN em conexões/datasets
  (`assertCanUseConnection`, `visibleDatasetIds`), mas sem excluir
  projeto/dataset nem operar workers. A distinção entre os dois não está
  centralizada — vive espalhada em `requireRole(...)` chamada a chamada.
- **ANALYST** / **VIEWER**: sem privilégio hardcoded, dependem 100% de
  `AccessGrant` (READ/WRITE por escopo GLOBAL/PROJECT/DATASET).
- **TOKEN** (SDK/automação) e **DatabaseUser** (acesso SQL direto, ex. Power
  BI): identidades não-humanas, também regidas por `AccessGrant`.

**Fluxos críticos** (confirmados pelo único teste e2e existente + pelo
código): login → navegar projetos → abrir dataset → criar fonte/subir
arquivo → consultar dados/SQL → exportar. Fluxos administrativos: gerenciar
usuários/tokens/conexões/storage servers, configurar retenção/worker/
contrato SQL, auditoria.

**Classificação das telas:**
- **Operacionais** (uso frequente, quem opera dados no dia a dia):
  `/projects/[project]` (workspace), `/uploads`, `/dashboard`.
- **Analíticas**: aba "Consultar SQL" dentro do workspace, `/audit`.
- **Administrativas** (uso ocasional, admin): todo `/settings/*`, `/users`,
  `/tokens`, `/database-users`, `/storage-servers`.

---

## 2. Mapa de telas (18 rotas)

| Rota | Objetivo | Usuário | Ação primária | Observação |
|---|---|---|---|---|
| `/login` | autenticar | todos | Entrar | ok, sem problemas relevantes |
| `/dashboard` | saúde geral da plataforma | todos autenticados | nenhuma (leitura) | **sem filtro de RBAC**, sem auto-refresh |
| `/projects` | hub de projetos | todos | criar projeto | **sem empty state**, over-fetch, arquivo minificado (1 linha) |
| `/projects/[project]` | workspace: dataset→tabela→query | operação diária | navegar árvore / consultar SQL | tela central; **sem breadcrumb**, sem URL sync, 506 linhas |
| `/uploads` | monitorar filas de processamento | operação diária | reprocessar/cancelar falhas | **link quebrado p/ rota inexistente**, sem filtro RBAC, não cancela jobs de sync |
| `/knowledge`, `/knowledge/[slug]` | documentação in-app | todos | ler artigo | conteúdo estático; é a tela mais "correta" em padrões (tem breadcrumb) |
| `/settings` | hub de configuração | admin | navegar | sem checagem de role na própria página (delega pra cada destino) |
| `/settings/connections` | CRUD conexões externas | admin | nova conexão | delete sem type-to-confirm |
| `/settings/retention` | janelas de retenção + purga manual | admin | salvar / purgar agora | **purga irreversível sem type-to-confirm** |
| `/settings/sql-contract` | modo de validação SQL | admin | salvar modo | 2 padrões de salvar na mesma página (inconsistente) |
| `/settings/worker` + WorkersSection | limites + CRUD de perfis de worker | admin | salvar / novo worker | 2 botões primários competindo; modal de restart não reaproveita o confirm padrão |
| `/users` | CRUD usuários | admin | novo usuário | sem excluir (só desativar); **sem empty state** (único caso) |
| `/database-users` | usuários SQL diretos | admin | novo usuário SQL | bom padrão (CreateDialog genérico + SecretReveal) |
| `/storage-servers` | CRUD servidores de armazenamento | admin | adicionar servidor | **modal não usa `<dialog>` nativo** (div customizado); botão primário fora do PageHeader; delete sem type-to-confirm |
| `/tokens` | CRUD tokens de API | admin | novo token | bom padrão |
| `/audit` | trilha de auditoria | admin + data_manager | filtrar | única com paginação real e empty-state de "sem acesso" amigável |

---

## 3. Fluxos principais

### Upload até tabela consultável
Dentro do workspace: **2 cliques humanos** (abrir "Novo upload" + selecionar
arquivo/drag-drop). O resto — criar registro, subir para blob, preview,
confirmar import — é automático via polling client-side. Ponto fraco: sem
barra de progresso determinística na maior parte do processo (só texto de
estágio), e o preview ainda depende de um job assíncrono no worker (o
preview instantâneo via DuckDB-WASM no browser está no roadmap documentado
em `IMPROVEMENTS.md`, não implementado).

### Adicionar fonte externa (extract/live)
Wizard de 4 passos obrigatórios (Origem → Uso → Sincronização → Revisão),
mesmo para o caso trivial "copiar 1 tabela com config padrão" — mínimo 4
cliques de "avançar". Editar depois usa um formulário plano de passo único
— **padrão de interação diferente entre criar e editar a mesma entidade**.

### Excluir projeto/dataset
Único fluxo do sistema com confirmação proporcional ao risco real: modal
"Zona de perigo" exige digitar o nome exato antes de habilitar o botão
(coerente, já que é hard delete com DROP SCHEMA/TABLE real no storage).
Contraste: excluir Storage Server (afeta múltiplos datasets) e "Purgar
auditoria agora" (também irreversível) têm apenas confirmação genérica.

---

## 4. Problemas encontrados (classificados)

### Regra de negócio / segurança
- **RBAC inconsistente entre telas**: `/projects` e o workspace filtram por
  `visibleProjectIds(actor)`; `/dashboard` e `/uploads` não filtram —
  qualquer usuário autenticado vê nomes de projeto/dataset e status de
  freshness de projetos aos quais talvez não tenha acesso.
- Papel `role` é string livre no schema (`role String @default("VIEWER")`),
  sem `CHECK`/enum de banco — nada impede um valor fora do conjunto
  conhecido via script/seed direto.
- Confirmação de ações irreversíveis não é proporcional ao risco em todo o
  sistema (ver seção Fluxos).

### Fluxo
- Workspace (`/projects/[project]`) não sincroniza abas abertas com a URL:
  refresh do navegador ou compartilhar link perde todo o contexto de
  navegação; impossível deep-link para uma tabela específica.
- `/uploads` não permite cancelar/reprocessar jobs de sincronização de
  fonte (SOURCE_REFRESH) pela própria tela — só de dentro do workspace,
  quebrando a promessa da tela de ser "central de controle da fila".
- SourceDialog exige 4 passos mesmo no caso trivial; nenhum atalho de
  "criar com padrões".

### Arquitetura de informação
- **Sem breadcrumb no workspace** — a tela mais complexa e mais usada do
  produto não mostra "Projetos > Nome do Projeto" em lugar nenhum visível
  (só o nome pequeno no rodapé da sidebar). Ironicamente, `/knowledge/[slug]`
  (a tela mais simples) é a única com breadcrumb correto.
- Botão de ação primária muda de posição entre telas (`PageHeader.actions`
  na maioria; dentro do `Panel` em storage-servers e workers) — quebra a
  resposta rápida a "o que posso fazer aqui".
- Organização de arquivo por "quem criou" e não por "quem usa":
  `CancelQueueButton` mora em `components/dashboard/` mas só é usado em
  `/uploads`.

### UX
- **Bug real de navegação**: o link "N concluídos" em cada `QueueLane` de
  `/uploads` aponta para `/uploads/history`, rota que **não existe** (404).
  Os componentes `upload-card.tsx`, `upload-filters.tsx`,
  `upload-funnel.tsx`, `upload-pagination.tsx`, `source-refresh-card.tsx`
  (~670 linhas) claramente foram escritos para essa página e nunca
  conectados — ou a rota foi removida e ninguém tirou o link e os
  componentes órfãos.
- 5 padrões distintos de "editar" entre as telas administrativas (modal
  reaproveitando dialog de criação em connections; modal totalmente custom
  em storage-servers; modal próprio em workers; modal separado de criar em
  users; combinado com exclusão em projeto/dataset).
- Confirmação de exclusão/revogação com rigor inconsistente entre telas de
  gravidade equivalente (ver seção Fluxos).
- `/users` é a única listagem sem `EmptyState` quando vazia.
- `/settings/sql-contract` tem dois padrões de salvar na mesma página
  (modo exige clicar "Salvar"; formato de resultado salva instantâneo ao
  clicar) — o usuário não tem como prever qual ação é imediata.

### Visual
- Nenhum problema visual sistêmico grave (paleta consistente via tokens
  DaisyUI, sem hex cru, dark mode bem implementado com script anti-FOUC).
  Os problemas visuais existentes são reflexo de inconsistência estrutural
  (3 implementações de "modal" coexistindo), não de estilo em si.

### Técnico (frontend)
- Sem `DataTable` genérico: 13 `<table>` cruas, só 4 aplicam a classe
  `.table-stack` que dá tratamento responsivo mobile — 9 tabelas ficam
  sujeitas a overflow horizontal sem tratamento em telas pequenas.
- Sem `<Modal>`/`useDialog()` compartilhado: 17 arquivos reimplementam o
  boilerplate de `<dialog>` + `showModal()`.
- `project-workspace.tsx` (506 linhas) é o maior componente do projeto,
  mistura layout de alto nível com features completas inline (MetadataPanel,
  DeleteTableButton, ProjectMigrateStorageDialog deveriam ser arquivos
  próprios, como já é o padrão em `dataset/` e `table-detail/`).
- 4 implementações duplicadas do mesmo padrão "copiar valor com feedback"
  (`CopyId` em project-workspace, `CopyField`×2, `CopyableId`).
- Lógica de "refresh de fonte" duplicada em 5 lugares sem hook comum,
  apesar de `useApiAction` já existir e ser usado para outras ações.
- 3 implementações distintas de polling (setInterval condicional no
  workspace, no upload-poller, e dois loops `for`+`setTimeout` manuais no
  UploadFlow) — candidatas a um `usePoll`/`useJobStatus` único.
- `apiRequest` (client HTTP centralizado, com tratamento de erro/401
  uniforme) existe e é robusto, mas **24 arquivos ainda usam `fetch()`
  cru**, perdendo esse tratamento.
- Sem React Query/SWR — tudo `useEffect`+`useState` manual, sem
  `AbortController` visível: risco crescente de race conditions.
- Editor SQL do QueryPanel é um `<textarea>` puro, sem syntax highlight nem
  autocomplete por teclado — limitação relevante na superfície de maior
  poder do produto.
- Código morto confirmado: os 5 componentes de upload já citados (~670
  linhas), o modo "standalone" não usado de `TablePanel` (~60 linhas), e
  variáveis mortas em `powerbi-dialog.tsx` (`setToken`/`serviceUrl`) que
  sugerem uma integração Power BI parcialmente implementada.
- Único erro de lint em código de UI: aspas não escapadas em
  `settings/retention/page.tsx:317`.

---

## 5. Inconsistências (padrões conflitantes)

1. **Editar**: 5 comportamentos diferentes entre 8 telas com CRUD.
2. **Confirmação de ação destrutiva**: só a exclusão de projeto/dataset
   usa type-to-confirm; purga de auditoria e exclusão de storage server
   (igualmente irreversíveis) usam confirmação genérica.
3. **Modal**: dialog nativo (padrão dominante) vs. div customizado
   (storage-servers) vs. UI própria sem reaproveitar `useFeedback`
   (RestartDialog de workers).
4. **Paginação/busca**: só `/audit` implementa; `/users`, `/tokens`,
   `/database-users`, `/settings/connections`, `/storage-servers` carregam
   tudo de uma vez.
5. **Posição do botão de ação primária**: `PageHeader.actions` na maioria;
   dentro do `Panel` em 2 telas.
6. **Salvar configuração**: botão explícito (maioria) vs. salvar instantâneo
   ao clicar (resultFormat em sql-contract).
7. **Componente "copiar valor"**: 4 implementações da mesma ideia.

---

## 6. Oportunidades de simplificação

- Um `FormDialog` genérico (`{title, fields, onSubmit, trigger}`) resolveria
  ~70% da duplicação entre `create-catalog-dialog`, `create-dialog`,
  `edit-catalog-dialog`, `user-dialogs` e o formulário manual de
  storage-servers.
- Um `<DangerZone requireTypedName onConfirm>` reutilizável (hoje só existe
  dentro de `EditCatalogDialog`) padronizaria confirmação proporcional em
  storage-servers e retention/purge.
- Um `<DataTable>`/`<Table>` compartilhado que aplique `.table-stack` por
  padrão eliminaria a duplicação de markup e a lacuna de responsividade
  mobile de uma vez.
- Um hook `useSourceRefresh()`/`useJobPoll()` substituiria as 5 + 3
  implementações duplicadas de refresh/polling.
- Resolver a decisão pendente do `/uploads/history` (ver seção de decisões)
  elimina ~670 linhas de código morto ou entrega a feature que falta.

---

## 7. Arquitetura UX proposta (visão geral, sem reescrever telas saudáveis)

- **Workspace ganha cabeçalho fixo com breadcrumb** ("Projetos / {Projeto}")
  e sincroniza a aba ativa com a URL (`?tab=`), permitindo compartilhar link
  e sobreviver a refresh.
- **RBAC aplicado uniformemente**: todo fetch de listagem/agregação (dashboard,
  uploads) passa pelo mesmo filtro `visibleProjectIds`/`visibleDatasetIds`
  já usado em `/projects`.
- **Confirmação de ação destrutiva em 2 níveis**, aplicados por regra, não
  por tela: (a) reversível/simples → confirm genérico; (b) irreversível de
  verdade (hard delete, purga, remoção de servidor com dados associados) →
  `DangerZone` com type-to-confirm. Hoje o nível é decidido caso a caso sem
  critério documentado.
- **`/uploads` vira de fato "central de controle da fila"**: cancelar/retry
  também para jobs de sincronização de fonte, e o link de histórico aponta
  para algo real (ver decisão pendente).
- **Botão de ação primária sempre no `PageHeader.actions`**, nunca dentro do
  `Panel` — regra única para todas as telas de listagem/configuração.

---

## 8. Design system proposto (consolidação, não reescrita)

O design system já existente (DaisyUI + tokens OKLCH + dark mode +
`primitives.tsx`/`feedback.tsx`) é sólido e deve ser mantido como base. Faltam
3 componentes para fechar as lacunas encontradas:

1. **`<Modal>` / `useDialog()`** — encapsula `ref` + `showModal/close` +
   `aria-labelledby` + backdrop, elimina os 17 reimplementações e a exceção
   de storage-servers (que nem usa `<dialog>` nativo).
2. **`<DataTable>`** — cabeçalho, `.table-stack` responsivo por padrão,
   slot de ações por linha, empty state e loading state embutidos.
3. **`<FormDialog>`** — composição de `<Modal>` + form state + error alert +
   `modal-action` padrão (Cancelar/Salvar), usado por todo CRUD simples.

Nenhum componente novo além desses três é necessário — os primitivos atuais
(`Button`, `PageHeader`, `Panel`, `StatusBadge`, `EmptyState`, `StatCard`,
`CopyableId`, `<Time>`) já cobrem bem o resto e devem só ganhar adoção mais
consistente (ex.: usar `<Button>` em vez de `btn` cru, usar `StatusBadge`
para novos domínios de status em vez de badges ad hoc).

---

## 9. Decisões de produto necessárias antes de implementar

Por instrução explícita da tarefa, não assumo silenciosamente mudanças de
comportamento de negócio. Preciso de decisão sua nos seguintes pontos antes
de tocar código:

1. **`/uploads/history`**: a página deveria existir (e os ~670 linhas de
   `upload-card`/`upload-filters`/`upload-funnel`/`upload-pagination`/
   `source-refresh-card` são o material para construí-la) ou o link e esses
   componentes devem ser removidos como código morto?
2. **DATA_MANAGER vs ADMIN**: a distinção de poderes entre os dois hoje está
   espalhada e parcialmente equiparada (conexões/datasets sim, exclusão e
   workers não). Confirma que esse é o comportamento pretendido antes de eu
   tocar em qualquer `requireRole`?
3. **Nível de confirmação por ação**: concorda com a proposta de 2 níveis
   (seção 7), aplicando type-to-confirm também a "excluir storage server" e
   "purgar auditoria agora"?
4. **`powerbi-dialog.tsx`** (variáveis mortas `setToken`/`serviceUrl`): a
   integração Power BI está pendente de terminar ou deve ser revertida/
   simplificada?

---

## 10. Plano de implementação

Priorizado por impacto × frequência ÷ esforço, conforme pedido.

**P0 — crítico**
- Corrigir/remover o link quebrado de `/uploads` → `/uploads/history`
  (depende da decisão 1).
- Aplicar filtro de RBAC em `/dashboard` e `/uploads` (mesmo padrão de
  `/projects`).
- Trocar o modal customizado de `/storage-servers` pelo `<dialog>` nativo
  padrão do app.
- Padronizar confirmação proporcional (type-to-confirm) em "excluir storage
  server" e "purgar auditoria agora" (depende da decisão 3).

**P1 — alto impacto**
- Breadcrumb + sincronização de aba com URL no workspace.
- Criar `<Modal>`, `<DataTable>`, `<FormDialog>` no design system e migrar
  os casos mais duplicados (dialogs de CRUD administrativo primeiro).
- Adicionar paginação/busca às 5 telas de listagem sem isso.
- Migrar os 24 usos de `fetch()` cru para `apiRequest`.
- Permitir cancelar/retry de jobs SOURCE_REFRESH em `/uploads`.

**P2 — padronização**
- Unificar posição do botão de ação primária (sempre `PageHeader.actions`).
- Unificar padrão de "editar" usando `<FormDialog>`.
- Unificar componente de "copiar valor" (remover as 3 duplicatas, manter
  `CopyableId`).
- Extrair hook único de refresh de fonte / polling de job.
- `EmptyState` consistente em todas as listagens (começando por `/users`).
- Unificar padrão de salvar em `/settings/sql-contract`.

**P3 — refinamentos**
- Decompor `project-workspace.tsx` em arquivos por feature (seguindo o
  padrão já usado em `dataset/` e `table-detail/`).
- Reformatar `/projects/page.tsx` (hoje minificado em 1 linha).
- Avaliar atalho "criar fonte com padrões" no SourceDialog (menos cliques
  no caso trivial).
- Avaliar editor de SQL com syntax highlight (CodeMirror/Monaco) — maior
  esforço, mas alto valor na tela de maior poder do produto.
- Resolver `powerbi-dialog.tsx` conforme decisão 4.
- Remover modo "standalone" morto de `TablePanel`.

---

## Próximo passo

Aguardando suas respostas às 4 decisões da seção 9 (ou autorização para eu
tomar a opção recomendada em cada uma) para começar a implementação pelo
P0. Posso começar já pelos itens de P0 que **não** dependem de decisão
(filtro de RBAC em dashboard/uploads, modal de storage-servers) enquanto
você decide o resto, se preferir.
