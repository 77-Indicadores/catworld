# Contrato de disponibilidade e previsibilidade

Testado em `src/app/api/availability.test.ts` (roda no CI).

**Sondas**
- `GET /api/health/live`: 200 sem tocar em banco (processo vivo).
- `GET /api/health/ready`: 200 `{status:"ready"}` se plano de controle e storage respondem; senao 503 `{status:"not_ready"}` — o motivo vai so para o log.
- `GET /api/health/status`: anonimo ve so `sql.ok`; autenticado ve commit/latencia/erro. Sondas nao geram eventos de auditoria.
- Worker: pulsacao a cada ~15s em `cw_system_settings`, consumida por `scripts/worker-healthcheck.mjs` (90s = travado).

**Erros**
- Falha interna: 500 `INTERNAL_ERROR` generico com `details.errorId` (mensagem original so no log/Sentry). Erros de conexao de banco nunca chegam ao cliente.
- Entrada invalida: 400 (`VALIDATION_ERROR`, `INVALID_JSON`, `INVALID_CRON`); conflito: 409 `CONFLICT`; timeout de consulta: 408 `QUERY_TIMEOUT`.

**Sobrecarga**
- 429 `TOO_MANY_CONCURRENT_QUERIES` (8 consultas simultaneas) e 429 `RATE_LIMIT_EXCEEDED` (por principal; consultas 60/min, uploads 60/min, demais 2400/min; OData isento) com `Retry-After`. O limite e por instancia (nao compartilhado entre replicas).

**Degradacao**
- Painel do worker: banco indisponivel ou valor invalido => env/default (nunca NaN/0). Retencao idem.
- Falha ao gravar auditoria nunca derruba a requisicao. `claim` transiente do worker e logado e repetido; jobs presos sao recuperados (`recoverStale`) e liberados no restart (`releaseSelf`).
