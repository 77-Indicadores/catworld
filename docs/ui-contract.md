# Contrato da interface

Como a tela se comporta em relação às regras da API (revisão de UX/premissas):

- **Erros:** toda chamada da interface passa por `src/lib/api-client.ts` (`apiRequest`/`apiErrorText`): mensagem em português por código (`FORBIDDEN`, `CONNECTION_FORBIDDEN`, `SCHEMA_FORBIDDEN`, `INVALID_CRON`, `CONFLICT`, `RATE_LIMIT_EXCEEDED` com "tente em Ns", 500 com código de suporte `errorId`, rede fora do ar). Nenhuma ação falha em silêncio; 401 leva ao login.
- **Confirmações e avisos:** `useFeedback()` (`components/ui/feedback.tsx`) substitui `confirm()`/`alert()` — diálogo com consequência explícita, foco e Esc; nomear a tabela para exclusões irreversíveis; avisos com `aria-live`. `useApiAction()` executa a escrita e avisa sucesso/erro.
- **Avisos da API:** `meta.warnings` aparece no painel de consulta. A consulta pede o formato normalizado.
- **Segredos exibidos uma vez** (token, senha SQL, rotação): `SecretReveal` — Esc/clique fora não fecham; "Concluir" só depois de confirmar que guardou.
- **Papéis:** o menu mostra Auditoria para ADMIN/DATA_MANAGER e Configurações só para ADMIN; o rodapé mostra usuário e papel reais e "Sair" encerra a sessão (evento `LOGOUT`).
- **Auditoria:** `/audit` filtra por tipo, resultado, período, usuário e token, com paginação por cursor, IP e detalhe; a leitura da própria tela é auditada.
- **Limites** em Configurações espelham a API: worker 1–20 / 1–20 / 0–5000 ms; retenção 1–3650 dias (versões 1–1000), com validação inline e aviso de que eventos de auditoria apagados não voltam.
- **Cron** (`CronPreview`): sempre UTC, próximas execuções e atalhos; inválido é recusado pela API (400).
- **Erros de página:** `error.tsx` e `global-error.tsx` em português, com "Tentar novamente" e o código do erro; `dashboard/loading.tsx` para o carregamento.
