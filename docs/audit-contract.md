# Contrato de auditoria

Tabela `cw_audit_events` (retencao pelo cleanup diario do worker). Leitura: `GET /api/v1/audit-events` (ADMIN/DATA_MANAGER), 100 por pagina, `meta.nextCursor`.
Filtros opcionais: `eventType`, `success=true|false`, `userId`, `tokenId`, `since`, `until` (ISO), `cursor` (uuid). Sem filtros = comportamento anterior.

| eventType | Quando | Detalhe |
|---|---|---|
| `API_WRITE` | toda escrita autenticada (POST/PATCH/PUT/DELETE que muda estado) | `{method, fields}` (nomes dos campos do corpo, nunca valores); em erro: `success=false` + `{status, code}` |
| `DATA_READ` | leitura de dados: OData, linhas de tabela, exportacao, consulta em fonte live | rota; no maximo 1 por ator+rota por minuto |
| `ADMIN_READ` | leitura de areas sensiveis: tokens, usuarios, usuarios SQL, conexoes, servidores, configuracoes, auditoria | rota; idem 1/min |
| `ACCESS_DENIED` | 403/429 em qualquer metodo (leituras viram este tipo; escritas negadas ficam como `API_WRITE` falho) | `{method, status, code}` |
| `AUTH_FAILED` | 401 (token invalido/sessao ausente) | no maximo 1 por IP a cada 10s |
| `LOGIN_SUCCESS` / `LOGIN_FAILED` / `LOGOUT` | autenticacao | motivo (`unknown_user`, `bad_password`, `inactive`, `invalid_input`); email so em falha/sucesso, **nunca a senha** |
| `JOB_COMPLETED` / `JOB_FAILED` | worker: upload, refresh de fonte/derivada, cleanup | `{jobId, type, worker, durationMs, attempts, willRetry, error(500 chars)}`; recurso = upload/fonte/derivada |
| `QUERY_EXECUTED` | consulta SQL | rowCount, tempo |
| `SQL_CONTRACT_MODE_CHANGED`, `UPLOAD_IMPORT_PERF` | eventos especificos | — |

Sempre: usuario ou token (`userId`/`tokenId`), `ipAddress` (x-forwarded-for, 1o salto). **Nunca** grava corpo, query string ou cabecalhos.
POSTs que so leem/testam (`/queries`, `/queries/export`, `*/query`, `*/test`) nao entram como `API_WRITE`.
Falha ao gravar auditoria e logada e nunca derruba a requisicao.
