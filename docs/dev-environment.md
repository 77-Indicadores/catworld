# Ambiente de desenvolvimento isolado

O `.env` local **nao aponta para producao**. As credenciais de producao ficam comentadas com o prefixo
`# [PROD-DESATIVADO]` (valores preservados, inativos). O bloco `# [DEV-DOCKER]` no fim do arquivo aponta para
o `docker-compose.dev.yml`, com chaves geradas so para dev.

## Subir

```bash
docker compose -f docker-compose.dev.yml up -d postgres          # plano de controle + storage Postgres (porta 5433)
docker compose -f docker-compose.dev.yml --profile mssql up -d   # + SQL Server (porta 1434) — exige aceitar o EULA Developer
```

## Primeira vez (banco vazio)

```bash
docker exec catworld-dev-postgres psql -U catworld -d postgres -c "CREATE DATABASE cw_dev_store"
npx prisma db push --skip-generate      # o historico de migracoes e incremental (sem baseline): use db push em banco novo
npx tsx prisma/seed.ts                  # admin de dev (email/senha no bloco [DEV-DOCKER] do .env)
docker exec catworld-dev-postgres psql -U catworld -d cw_dev -c "INSERT INTO cw_storage_servers (id,name,url,provider,is_default,active,updated_at) VALUES ('11111111-1111-4111-8111-111111111111','dev-pg','postgres://catworld:catworld_dev@localhost:5433/cw_dev_store','postgres',true,true,now())"
```

## Conformidade do contrato de SQL contra Postgres real

```bash
CW_TEST_PG_URL=postgres://catworld:catworld_dev@localhost:5433/postgres npx vitest run conformance
```

## Voltar a producao

Descomente as linhas `# [PROD-DESATIVADO]` e comente o bloco `[DEV-DOCKER]`. Faca isso conscientemente: o servidor
de dev passa a ler e escrever em producao.
