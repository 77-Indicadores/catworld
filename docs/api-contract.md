# Contrato da API — envelope, autenticação e erros

## Envelope

Toda rota de dados de `/api/v1` responde JSON no formato:

```json
{ "data": <qualquer coisa | null>, "meta": <objeto | null>, "error": null | { "code": "…", "message": "…", "details": <…> | null } }
```

`bigint` é serializado como string. **Exceções deliberadas** (não usam o envelope): stream NDJSON de `/queries` (`stream:true`),
exports (CSV/XLSX), OData (`/api/odata`, formato OData) e `/api/health/*` (probes). Um teste (`envelope.test.ts`) impede rotas
novas de `/api/v1` de responderem fora do envelope.

## Autenticação

| Forma | Onde |
|---|---|
| Cookie de sessão (usuário) | todas as rotas |
| `Authorization: Bearer cw_live_…` (token) | todas as rotas |
| Basic ou `?api_key=` | só OData |

- O `proxy.ts` **não protege `/api/*`**: cada rota autentica no próprio handler (`resolveActor`). O teste `auth-required.test.ts` falha
  se uma rota de `/api/v1` for criada sem isso. Exceções públicas: `auth/*` (login), `health/*`, `odata` (autentica por dentro).
- **Usuário**: o papel e o estado (`active`) vêm do **banco** (cache de 10 s), não do JWT. Rebaixar ou desativar um usuário vale em até
  10 s (na hora, na instância que fez a alteração). O JWT dura 8 h mas não sobrevive à desativação.
- **Token**: papel `TOKEN` (nunca `ADMIN`); escopo GLOBAL, PROJECT ou DATASET com permissão READ ou WRITE. `lastUsedAt` é gravado no
  máximo 1 vez por minuto.
- Ações **globais** de upload (`cancel-all`, `dismiss-failed`, `retry-failed`): só `ADMIN` e `DATA_MANAGER`.
- Derivadas: acesso READ/WRITE ao dataset, como as demais rotas de dataset.

## Erros

| Situação | Status | `error.code` |
|---|---|---|
| Não autenticado | 401 | `UNAUTHENTICATED` / `INVALID_TOKEN` |
| Sem permissão | 403 | `FORBIDDEN` |
| Corpo inválido (zod) | 400 | `VALIDATION_ERROR` — `details.issues[] = { path, code, message }` |
| JSON malformado | 400 | `INVALID_JSON` |
| SQL inválido/não permitido | 400 | `UNSAFE_SQL`, `UNSUPPORTED_CONSTRUCT`, `QUERY_FAILED`, `POSTGRES_QUERY_FAILED` |
| Limite de requisições | 429 | `RATE_LIMIT_EXCEEDED` — `details.retryAfterSeconds`, cabeçalho `Retry-After` |
| Falha interna | 500 | `INTERNAL_ERROR` — mensagem **genérica**, `details.errorId` |

- Erro de **validação e JSON inválido são do cliente** (400): não vão para o Sentry.
- **Erro interno**: o texto real (host, IP, driver) fica só no log e no Sentry, com o mesmo `errorId`. Nunca vai para o cliente. O
  Sentry não segura a resposta (sem `await flush`).
- **Erro de conexão com o banco de storage** em `/queries` (inclusive no stream) vira "Falha ao conectar ao banco de dados…"; erro do
  SQL do próprio usuário (sintaxe, coluna) continua com o texto do banco.

## Limite de requisições (em memória, por instância e por principal)

| Faixa | Limite/min | Onde |
|---|---|---|
| `query` | 60 | `POST /api/v1/queries` |
| `upload` | 60 | `POST /api/v1/uploads` (criar) |
| `default` | 2400 | demais rotas autenticadas com `request` (não conta renderização de página); **OData fica fora** |

Além disso, no máximo 8 consultas simultâneas globais. O limite `default` é uma proteção contra laço descontrolado, não contra uso
legítimo (o SDK pagina tabelas grandes com dezenas de requisições por segundo). Com mais de uma instância, cada uma conta separado.
