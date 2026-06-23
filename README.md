# Catworld

Camada de catálogo, governança e acesso sobre Azure SQL. O Catworld oferece frontend, API REST e SDK Python sem exigir drivers SQL nas aplicações consumidoras.

## Arquitetura

- Next.js: frontend e `/api/v1`.
- Prisma + Azure SQL: catálogo `dbo.cw_*`.
- `mssql`/Tedious: schemas, consultas, bulk import e usuários SQL.
- Armazenamento local em disco (`CATWORLD_UPLOAD_DIR`): arquivos originais de upload.
- Worker separado: preview e importações assíncronas.
- Um schema por dataset: `d_<projeto>__<dataset>`.

## Desenvolvimento

```powershell
Copy-Item .env.example .env
npm install
npm run db:generate
node scripts/create-database.mjs
npm run migrate
npm run seed
npm run dev
```

Em outro terminal:

```powershell
npm run worker
```

O seed exige `CATWORLD_ADMIN_PASSWORD`. Não há fallback automático para mocks quando o banco está indisponível.

## Docker / Coolify

A mesma imagem deve ser publicada em dois serviços (veja `docker-compose.example.yml`, copie para `docker-compose.yml` e ajuste antes de usar):

- web: `node server.js`
- worker: `./node_modules/.bin/tsx src/worker/index.ts`

Use as mesmas variáveis e a mesma imagem para ambos. **Os dois serviços precisam compartilhar o mesmo volume** apontado por `CATWORLD_UPLOAD_DIR` (ex: `/data/uploads`) — o `web` grava o arquivo enviado e o `worker` precisa lê-lo do mesmo disco; sem volume compartilhado os uploads falham. Execute `npm run migrate` e `npm run seed` como comandos de implantação controlados (no Coolify, configure como post-deployment command). O worker inclui LibreOffice Calc para converter `.xls` legado antes do processamento.

## Segurança

- Login por email/senha, sessão JWT e Argon2id.
- Tokens `cw_live_` armazenados apenas como SHA-256.
- Credenciais secundárias protegidas por AES-256-GCM.
- Consultas aceitam apenas uma instrução `SELECT` ou `WITH`.
- Execução via principal SQL `WITHOUT LOGIN` e `EXECUTE AS USER`.
- Usuários SQL externos recebem somente presets de leitura ou escrita por schema.

## API

Respostas usam `{ data, meta, error }`. Principais rotas:

- `GET/POST /api/v1/projects`
- `GET/POST /api/v1/projects/:id/datasets`
- `GET /api/v1/datasets/:id/tables`
- `GET /api/v1/tables/:id/rows`
- `POST /api/v1/uploads`
- `POST /api/v1/queries`
- `POST /api/v1/queries/export`
- `GET/POST /api/v1/tokens`
- `GET/POST /api/v1/database-users`
- `GET/POST /api/v1/connections`
- `GET /api/v1/audit-events`

## SDK Python

```powershell
pip install -e sdk/python
```

```python
from catworld import CatworldClient

with CatworldClient("https://catworld.exemplo.com", "cw_live_...") as client:
    print(client.projects())
    result = client.query("SELECT TOP 10 * FROM [d_financeiro__faturamento].[vendas]")
```

## Gates

```powershell
npm run check:encoding
npm run lint
npm run typecheck
npm test
npm run build
npm run e2e
```

Os testes de integração/E2E completos precisam de SQL Server e Azurite. A CI sobe ambos automaticamente.