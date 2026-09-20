# Contrato da interface

Como a tela se comporta em relação às regras da API (revisão de UX/premissas):

- **Erros:** toda chamada da interface passa por `src/lib/api-client.ts` (`apiRequest`/`apiErrorText`): mensagem em português por código (`FORBIDDEN`, `CONNECTION_FORBIDDEN`, `SCHEMA_FORBIDDEN`, `INVALID_CRON`, `CONFLICT`, `RATE_LIMIT_EXCEEDED` com "tente em Ns", 500 com código de suporte `errorId`, rede fora do ar). Nenhuma ação falha em silêncio; 401 leva ao login.
- **Confirmações e avisos:** `useFeedback()` (`components/ui/feedback.tsx`) substitui `confirm()`/`alert()` — diálogo com consequência explícita, foco e Esc; nomear a tabela para exclusões irreversíveis; avisos com `aria-live`. `useApiAction()` executa a escrita e avisa sucesso/erro.
- **Avisos da API:** `meta.warnings` aparece no painel de consulta. A consulta pede o formato normalizado.
- **Segredos exibidos uma vez** (token, senha SQL, rotação): `SecretReveal` — Esc/clique fora não fecham; "Concluir" só depois de confirmar que guardou.
- **Papéis:** o menu mostra Auditoria para ADMIN/DATA_MANAGER e Configurações só para ADMIN; o rodapé mostra usuário e papel reais e "Sair" encerra a sessão (evento `LOGOUT`).
- **Auditoria:** `/audit` filtra por tipo, resultado, período, usuário e token, com paginação por cursor, IP e detalhe; a leitura da própria tela é auditada.
- **Limites** em Configurações espelham a API: worker 1–20 / 1–20 / 0–5000 ms; retenção 1–3650 dias (versões 1–1000), com validação inline e aviso de que eventos de auditoria apagados não voltam.
- **Fonte (criar/editar):** seção opcional só com coluna-chave em modo extract: interruptor "Marcar como excluídas as linhas que somem da origem" (`detectDeletions`, com texto explicando que só a coluna-chave é lida e que nada é apagado), e, com ele ligado, a consulta de chaves (só fonte por consulta, obrigatória) e o "Intervalo mínimo entre leituras (min)" opcional. Os erros `DELETE_DETECTION_REQUIRES_KEY`/`KEYS_SQL_*`/`INVALID_KEYS_INTERVAL` da API aparecem como mensagem do formulário.
- **Cron** (`CronPreview`): sempre UTC, próximas execuções e atalhos; inválido é recusado pela API (400).
- **Erros de página:** `error.tsx` e `global-error.tsx` em português, com "Tentar novamente" e o código do erro; `dashboard/loading.tsx` para o carregamento.

## Camada de apresentação (`src/lib/present/`)

Toda data, contagem e estado mostrado na tela passa por funções puras desta camada; nenhum componente formata por conta própria.

- **Datas:** `presentDateTime` e o componente `<Time iso>` mostram `dd/mm/aaaa HH:mm` no fuso do navegador, o relativo ("há 12 min") e, no `title`, o instante em UTC. O servidor só envia ISO; `<Time>` usa `useSyncExternalStore` para não quebrar a hidratação. Crons continuam rotulados em UTC.
- **Contagens:** `presentCount`/`formatInt` são exatos (BigInt, sem perder precisão) nos painéis de detalhe; o formato compacto ("1,5 mi") só em listas e sempre com o valor exato no `title`.
- **Estado e frescor:** `normalizeRunStatus` unifica `completed|ok|ready`. `presentRefreshFreshness`/`presentTableFreshness` devolvem Em dia, Atrasada, Com erro, Atualizando, Na fila, Pausada, Manual, Ao vivo ou Aguardando 1ª carga. "Atrasada" só vale para fonte agendada, com tolerância `max(2 min, 10% do intervalo)`; tabela só de upload é neutra ("Atualizada há X"); a tabela mostra o pior estado das fontes.
- **Uso:** `usage.ts` gera o nome SQL qualificado (`schema.tabela`), a URL OData por tabela e os exemplos do protocolo `since` (REST e SDK).
- **Testes de consistência** (`present-consistency.test.ts`): falham se aparecer `toLocaleString`, `toFixed`, `Intl.*` fora da camada, ou `text-base-content/N` com N < 65 (contraste).

## Espaço de trabalho

- **Tipos e serializer únicos:** `src/lib/workspace/{types,serialize}.ts` (BigInt vira string, Date vira ISO); `present.ts` traduz fonte/derivada/tabela em frescor e origem.
- **Detalhe da tabela** (`workspace/table-detail/`): blocos Frescor (última/próxima atualização, erros de todas as fontes, contagem exata), Origem (arquivo, conexão, `schema.tabela` ou SQL, chave, cron, "Detecção de exclusões: ativa" com a última leitura de chaves e as linhas marcadas como excluídas na última atualização), Uso (nome SQL, URL OData, `since`) e Histórico.
- **Histórico:** `GET /api/v1/tables/:id/history?limit=1..50` (mesma autenticação das demais rotas; exige leitura do dataset) devolve versões e execuções. Usa as colunas aditivas `cw_uploads.created_by` e `cw_job_metrics.table_id`; registros antigos ficam sem esses campos e o bloco cai para `cw_jobs` retido.
- **Dashboard e árvore:** lista "Precisa de atenção" (falhando, atrasada) e ponto de estado por tabela/dataset, com texto acessível (não só cor).
- **Consulta SQL:** navegador de tabelas e colunas (clicar insere `schema.tabela` ou a coluna), NULL destacado, números à direita, "Mostrando as primeiras N de M linhas".

## Mobile e acessibilidade

- Tabelas de gestão usam `table-stack`: abaixo de 768 px cada linha vira um cartão com o rótulo (`data-label`) ao lado do valor, e as ações ficam sempre à vista. Toda nova tabela larga deve usar a classe e `data-label` em cada `<td>` (vazio na coluna de ações).
- Texto secundário nunca abaixo de `/65` de opacidade.

## Auditoria, tokens e usuários

- `/audit` troca ids por nomes (projeto, dataset, tabela, fonte, derivada, upload, token, usuário) resolvidos em lote (`resolveAuditNames`, uma consulta por tipo); id sem correspondência continua como id, e o `title` guarda o valor original.
- Tokens mostram quem criou (`cw_tokens.created_by`: e-mail ou `token:<nome>`); usuários mostram o último login (`cw_users.last_login_at`, gravado no `LOGIN_SUCCESS`). Ambas as colunas são opcionais e aditivas.
