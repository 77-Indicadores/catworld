# Contrato de auditoria

Tabela `cw_audit_events` (retencao pelo cleanup diario do worker). Leitura: `GET /api/v1/audit-events` (ADMIN/DATA_MANAGER), 100 por pagina, `meta.nextCursor`.
Filtros opcionais: `eventType`, `success=true|false`, `userId`, `tokenId`, `since`, `until` (ISO), `cursor` (uuid). Sem filtros = comportamento anterior.

| eventType | Quando | Campos |
|---|---|---|
| `API_WRITE` | toda escrita autenticada (POST/PATCH/PUT/DELETE que muda estado) | `resourceId` = rota, `detailJson` `{method}`; se a requisicao terminar em erro: `success=false` e `{status, code}` |
| `AUTH_FAILED` | 401 (token invalido/sessao ausente) | rota, `{method, code}`, IP; no maximo 1 por IP a cada 10s |
| `QUERY_EXECUTED` | consulta SQL | rowCount, tempo |
| `SQL_CONTRACT_MODE_CHANGED` | troca do modo do contrato SQL | novo modo |

Sempre: usuario ou token (`userId`/`tokenId`), `ipAddress` (x-forwarded-for, 1o salto). **Nunca** grava corpo, query string ou cabecalhos.
POSTs que so leem/testam (`/queries`, `/queries/export`, `*/query`, `*/test`) nao entram como `API_WRITE`.
Falha ao gravar auditoria e logada e nunca derruba a requisicao.
