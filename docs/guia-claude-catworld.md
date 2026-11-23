# Guia operacional do Catworld (para Claude e para gente)

Como o Catworld funciona e como **montar, cadastrar, editar, recarregar e apagar** queries/tabelas sem quebrar
painel de cliente. Escrito a partir de operações reais (TMK, Esfera, Bailon, Jacy). Detalhe de cada contrato está
nos outros arquivos de `docs/` — aqui é o mapa e o passo a passo.

> Produção: `https://catworld.77indicadores.com.br` · Deploy: Coolify em `https://app.77indicadores.com.br/`
> (push na `master` dispara o deploy sozinho; leva ~5 min).

---

## 1. Modelo mental (5 minutos)

```
Projeto (cliente: TMK-CONSTRUTORA, ESFERA, BAILON...)
 └─ Dataset (FTP, GERAL, LOJA 2...)  ──►  1 schema SQL no storage (ex.: d_tmk_construtora_ftp)
     └─ Tabela (dre_obras_mensal, cpcr_3_4...)
          └─ origem: UMA destas
               • Fonte (DatasetSource) — lê de uma Conexão (banco do cliente)
               • Upload — CSV/XLSX enviado (UI ou API)
               • Derivada — SQL sobre tabelas do próprio Catworld
Conexão (Connection): Postgres | SQL Server | Firebird via FTP
```

- **Schema do dataset**: nunca adivinhe. Leia `schemaName` em `GET /api/v1/datasets/:id`. Em geral é
  `d_<projeto>_<dataset>` em minúsculas, mas há exceções (ex.: LICITACAO do TMK).
- **Fonte `extract`**: copia os dados para o storage do Catworld (tabela física). Atualiza por cron, por
  "Atualizar" manual, ou — no Firebird via FTP — sozinha quando chega backup novo.
- **Fonte `live`**: não copia nada; cada consulta vai na origem na hora. A tela mostra "Ao vivo" (não tem data de
  atualização). Não existe live para Firebird.
- **Fonte por `table`** (escolhe tabela da origem) vs **por `query`** (SQL livre, nome da tabela é obrigatório).
- Cada fonte é dona de **exatamente uma** tabela. Criar uma fonte com o **mesmo nome** de uma tabela de upload que
  já existe faz a fonte **assumir** essa tabela (sem apagar antes, sem o painel ficar sem a tabela).

## 2. Acesso: quem pode o quê

| Ação | Precisa |
|---|---|
| Ler dados (`POST /queries`), listar datasets/fontes, criar/editar/atualizar/remover **fonte** | Token de API ou sessão com acesso WRITE ao projeto |
| Conexões (listar, criar, testar, **sondar colunas de uma query**, listar tabelas da origem) | **ADMIN** (sessão do navegador logado como admin) |
| **Apagar tabela** (`DELETE /tables/:id`) | **ADMIN** |
| Uploads (`GET /uploads`) | lista os uploads de **todos os projetos que o token enxerga** (os 100 mais recentes) — parâmetro `datasetId` na URL é ignorado; filtre pelo campo `datasetId` de cada item |

Dois jeitos de chamar a API:

1. **Token** (terminal/scripts): `Authorization: Bearer <token>`. Token fica num arquivo ignorado pelo git
   (ex.: `.env.catworld.local` com `CATWORLD_TOKEN=`). Quem cria o token é a pessoa, em Configurações → Tokens.
   Nunca digite/cole senha ou token você mesmo; peça para a pessoa colocar no arquivo.
2. **Sessão do navegador** (Claude in Chrome, logado como admin): `fetch('/api/v1/...')` via `javascript_tool`.
   Necessário para rotas ADMIN. Ver §8 sobre como não travar a aba.

### Helpers de terminal (copie para o scratchpad)

```bash
# api_get.sh  — uso: bash api_get.sh /api/v1/datasets/<id>
TOKEN="$(grep -E '^CATWORLD_TOKEN=' /caminho/catworld/.env.catworld.local | cut -d= -f2-)"
printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" | curl -sS --max-time 120 -K - "https://catworld.77indicadores.com.br$1"
```

```bash
# api_post_file.sh — uso: bash api_post_file.sh /api/v1/... corpo.json   (troque -X/--data-binary para PATCH)
TOKEN="$(grep -E '^CATWORLD_TOKEN=' /caminho/catworld/.env.catworld.local | cut -d= -f2-)"
printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" | curl -sS --max-time 400 -K - \
  -H 'content-type: application/json' --data-binary "@$2" "https://catworld.77indicadores.com.br$1"
```

- O token vai por `-K -` (stdin) para não aparecer na lista de processos.
- **Sempre mande o corpo por arquivo** (`--data-binary @arquivo`). Query grande (centenas de colunas) passada
  como argumento de linha de comando estoura o limite do Windows e chega truncada → `INVALID_JSON`.
- Gere o JSON com Python/`json.dumps` (nunca montando string na mão): SQL tem aspas, quebras de linha e acentos.

## 3. Descobrir IDs

```
GET /api/v1/projects                      → id, name, slug do projeto
GET /api/v1/projects/:id                  → datasets do projeto (id, name)
GET /api/v1/datasets/:id                  → schemaName, tables[] (name, rowCount, lastDataAt, columns, source)
GET /api/v1/datasets/:id/sources          → fontes (id, name, mode, lastStatus, lastRowCount, lastError, connection)
GET /api/v1/connections                   → (ADMIN) id/nome/provider das conexões
```

`tables[].source == null` → a tabela é de upload (ou derivada), não de fonte.

## 4. Ler dados — `POST /api/v1/queries`

```json
{ "projectId": "<uuid>", "sql": "select ... from d_x_y.tabela where ...", "limit": 10000, "timeout": 60 }
```

- O SQL roda no **storage do Catworld**, não na origem. Sempre qualifique `schema.tabela`.
- É um **subconjunto de T-SQL** traduzido (ver `docs/sql-contract.md`). Recusado: `count(*) filter (where ...)`,
  e outras construções só-Postgres → erro `UNSUPPORTED_CONSTRUCT`. Use `sum(case when ... then 1 else 0 end)`.
- Colunas vêm em minúsculas (`sqlName`). Colunas `cw_synced_at`/`cw_deleted_at` são do Catworld.
- Comparar texto com número dá `operator does not exist: text = integer` — compare como texto
  (`id_parcela = '112446'`) ou use `between 'x' and 'x'`.

## 5. Criar uma fonte por query

### 5.1 Antes: valide a query (ADMIN, navegador)

```js
await fetch(`/api/v1/connections/${connId}/columns?sql=${encodeURIComponent(sql)}`).then(r => r.json())
// data: [{ originalName, sqlName, sqlType, nullable }]  ou  error.message com o erro do banco
```

Isso só descreve as colunas (não lê linhas). No Firebird a 1ª chamada pode levar ~20 s (reabre o banco).

### 5.2 Criar

`POST /api/v1/datasets/:datasetId/sources`

```json
{ "connectionId": "<uuid>", "name": "nome_da_tabela", "mode": "extract", "sourceKind": "query",
  "sourceSql": "SELECT ...", "refreshCron": null, "keyColumn": null, "keysSql": null }
```

- Fonte por tabela: `"sourceKind": "table", "sourceSchema": "dbo", "sourceTables": ["T1","T2"]` (cria uma fonte
  por tabela; `name` é dispensado).
- `refreshCron` é cron em **UTC** (`"0 7-19/2 * * *"`). `null` = manual; em Firebird via FTP, `null` = atualiza
  quando chega backup novo (é o normal lá).
- A criação já valida a query e **enfileira a 1ª carga**. Acompanhe por `GET /dataset-sources/:id`
  (`lastStatus`: `queued` → `running` → `completed`/`failed`; `lastError`; `lastRowCount`).
- Se já existe tabela de **upload** com esse nome no dataset, a fonte assume a tabela. Se já existe **fonte** para
  ela → `409 SOURCE_ALREADY_EXISTS`.

### 5.3 Conferir a carga

Compare `lastRowCount` com a contagem esperada e as colunas (`GET /datasets/:id` → `tables[].columns`).
Queda grande de linhas vira `completed` com aviso `INTEGRITY_SUSPECT: DROP_GT_PCT` (tabela marcada "possivelmente
incompleta") — investigue antes de confiar: muitas vezes é a **query errada** (ex.: duas queries parecidas, uma
traz 1.016 equipamentos e a outra 542 ativos).

## 6. Editar, recarregar, remover

| Quero... | Como |
|---|---|
| Mudar o SQL | `PATCH /dataset-sources/:id` `{ "sourceSql": "..." }` e depois `POST /dataset-sources/:id/refresh` `{}` |
| SQL novo muda as **colunas** | Toda fonte por query recusa recarregar com estrutura nova (`SOURCE_SCHEMA_CHANGED`, "consulta com janela"). Faça: `PATCH { "sourceSqlReconciliation": "<mesmo SQL>" }` + `POST .../refresh { "reconciliation": true }`. Mantenha `sourceSql` e `sourceSqlReconciliation` iguais nas próximas edições |
| Recarregar agora | `POST /dataset-sources/:id/refresh` `{}` (cancelar: `?action=cancel`) |
| Aceitar uma queda grande de linhas legítima | `POST .../refresh { "acceptDrop": true }` (auditado) |
| Agendar | `PATCH { "refreshCron": "0 6 * * *" }` |
| Pausar | `PATCH { "active": false }` |
| Renomear | `PATCH { "name": "..." }` |
| Remover a fonte | `DELETE /dataset-sources/:id` — **extract: apaga a tabela física junto**; live: só tira do catálogo |
| Apagar uma tabela de upload | (ADMIN) `DELETE /tables/:id` com corpo `{ "confirmName": "<nome exato>" }` |
| "Mover" tabela para outro dataset | Não existe mover: crie a fonte igual no dataset novo, confira linhas/totais, depois remova a antiga. Avise quem consome o schema antigo (Power BI, painéis) |

Antes de apagar qualquer coisa: confira quem lê aquela tabela (grep no repositório do painel do cliente, ex.:
`dash_tmk`, e em outros repositórios do cliente) e mostre a lista para a pessoa confirmar.

## 7. Tipos de conexão — o que muda

### Postgres / SQL Server
- Conexão direta (opcionalmente via túnel SSH). Teste em Configurações → Conexões.
- **SQL Server com usuário restrito**: tabela sem `GRANT SELECT` dá *"The SELECT permission was denied on the
  object ..."* e, na criação, *"Fonte nao retornou colunas"* (o SQL Server esconde até as colunas). Para testar
  acesso de várias tabelas de uma vez: `POST /dataset-sources/:idDeUmaFonteLive/query` com
  `{ "sql": "SELECT TOP 1 * FROM dbo.TABELA", "limit": 1 }` (só funciona em fonte live).

### Firebird via FTP (`firebird-ftp`) — ver `docs/firebird-ftp-provider.md`
- O cliente deposita no FTP um ZIP com uma **cópia do .fdb** (ex.: `/PLV/*.zip` no TMK, `/Esfera/ESFERA.PLV.zip`).
  O Catworld baixa, descompacta e abre num **Firebird 5 nosso** (cópia efêmera; nunca o banco do cliente).
- Conexão: host/porta/usuário/senha do FTP, caminho remoto, padrão do arquivo (use o nome exato se houver
  backups antigos na pasta), charset (vazio = UTF8). A senha do FTP quem digita é a pessoa.
- A conexão verifica o FTP a cada N min; arquivo novo → **todas as fontes daquela conexão recarregam sozinhas**.
- Dialeto **Firebird** (não T-SQL): `FIRST n`, `SKIP`, `CAST(... AS DATE)`, datas `'01.01.2026'`,
  procedures selecionáveis (`SELECT * FROM S_PROC(params)`).
- Comportamentos do adapter (`src/server/connections/firebird.ts`), todos já tratados:
  - **Colunas de mesmo nome** (`SELECT a.*, b.*`): aceitas; a 2ª ocorrência vira `NOME_2`, a 3ª `NOME_3`.
    (O antigo export em CSV usava `NOME1` — se um painel lia essas colunas, ajuste o painel.)
  - **Tipos**: inteiros viram `BIGINT`, `NUMERIC/DECIMAL` viram `DECIMAL(p,s)` exato, datas `DATE`/`DATETIME2`/`TIME`,
    e o resto vira texto. **`DOUBLE PRECISION`/`FLOAT` viram texto** (regra do projeto: nunca arredondar sem
    pedir; ver `docs/source-type-mapping.md`). Se um consumidor faz conta no SQL com essa coluna (`COALESCE(x, 0)`,
    `x - y`), faça `CAST(X AS NUMERIC(18,4)) AS X` na query da fonte. Na conferência, compare com
    `SELECT pg_typeof(col)::text ...` via `/queries`: o tipo físico é o que vale.
  - **BLOB de texto** vem como texto (`blobAsText`). Query com BLOB é lida de uma vez, não em streaming
    (o driver trava/dá *"Invalid BLOB ID"* em streaming). **BLOB binário vira nulo** (aviso no log).
  - Leitura com BLOB roda em transação **leitura-escrita desfeita no fim**: procedures do ERP gravam durante o
    SELECT (contador `S_GER_RETCONTADOR` do Siecon).
  - UDF legada **`ib_udf`** (ex.: `FRAC`) está instalada na imagem (Dockerfile, `UdfAccess = Restrict UDF`).
    Outras bibliotecas externas (ex.: `rfunc`, `LONGPARSE`) **não** — se uma query falhar com
    *"Function X is not defined, module name or entrypoint could not be found"*, descubra o módulo com uma fonte
    temporária sobre `SELECT RDB$FUNCTION_NAME, RDB$MODULE_NAME, RDB$ENTRYPOINT FROM RDB$FUNCTIONS WHERE
    RDB$MODULE_NAME IS NOT NULL` e trate na imagem.
- Achar dados no ERP: `GET /connections/:id/tables` (ADMIN) lista as tabelas; `GET /connections/:id/columns?
  schema=public&table=X` mostra as colunas. Para ler linhas de verdade da origem é preciso criar uma fonte
  (temporária, prefixo `zz_`) e consultar pelo storage — e removê-la depois.

## 8. Ferramentas e armadilhas (aprendidas na prática)

- **Navegador**: chamadas longas (`await` de minutos) travam a aba do Claude in Chrome (timeout de 45 s do CDP).
  Padrão seguro: dispare em background e consulte depois:
  ```js
  window.__job = {stage:'start'}; (async () => { /* ... */ window.__job = {stage:'done', res}; })(); 'ok'
  // depois: JSON.stringify(window.__job)
  ```
  As abas do grupo podem trocar de id; chame `tabs_context_mcp` de novo se der "tab not in group".
- **Passar SQL grande para o navegador**: comprima (gzip+base64) e descomprima com `DecompressionStream`.
- **Navegador → disco local**: `fetch('http://127.0.0.1:...')` a partir do site é bloqueado (acesso à rede local
  do Chrome). Para exportar dados, use a API com token no terminal.
- **Timeouts**: criar fonte Firebird pode levar 1–2 min (reabre o banco). Use `--max-time 400` no curl.
- **Deploy**: push na `master` → Coolify faz build e deploy (~5 min). Acompanhe em app.77indicadores.com.br
  (CATWORLD → Deployment Logs). Confirme em produção depois (ex.: sondar uma query) antes de seguir.
- **Mudança em `firebird.ts`**: teste contra um Firebird 5 **real** antes do push. Driver simulado não pega
  travamento de protocolo (uma versão com `db.newStatement` + `release()` passou nos testes e travou produção).
  ```bash
  docker run -d --name cw-fb5-test -p 127.0.0.1:3055:3050 -e FIREBIRD_ROOT_PASSWORD=cwtest \
    -e FIREBIRD_DATABASE=test.fdb firebirdsql/firebird:5
  MSYS_NO_PATHCONV=1 CW_TEST_FIREBIRD_HOST=127.0.0.1 CW_TEST_FIREBIRD_PORT=3055 \
    CW_TEST_FIREBIRD_DATABASE=/var/lib/firebird/data/test.fdb CW_TEST_FIREBIRD_PASSWORD=cwtest \
    npx vitest run src/server/connections/firebird.test.ts
  ```
  Para testar algo da imagem (UDF, libs do sistema), monte uma imagem com a mesma base do Dockerfile
  (`node:22-bookworm-slim`) — a imagem `firebirdsql/firebird` é Debian 13 e não tem as mesmas libs.
- **Depois de `npm ci`**: rode `npx prisma generate`, senão o `tsc` acusa "untyped function calls".
- **Tabela ao vivo**: não tem "data de atualização"; a UI mostra só "Ao vivo".

## 9. Receita completa (exemplo real: queries do Siecon no dataset FTP do TMK)

1. Levantar o que o painel do cliente usa: no repositório do painel, procurar os nomes de tabela que os scripts de
   sync baixam (ex.: `dash_tmk/services/tmk-sync/*.py`, `archive/gerador-html/atualizar.py`).
2. Ligar cada tabela à query certa: sondar as colunas de cada `.sql` (§5.1) e comparar com as colunas da tabela
   atual (`GET /datasets/:id`). Empate de colunas → decidir pelo número de linhas ou pelos filtros do SQL.
3. Garantir que nada vai sobrescrever: se as tabelas vinham de upload automático, **desligar o job** antes
   (`GET /uploads` → `createdBy` mostra o token que envia).
4. Criar as fontes com o mesmo nome das tabelas (§5.2), uma por vez, corpo por arquivo.
5. Acompanhar até `completed` e comparar linhas/colunas com o snapshot anterior. Corrigir as que falharem
   (§7 lista os erros conhecidos do Firebird).
6. Apagar as tabelas que ninguém usa (ADMIN, `confirmName`), depois de mostrar a lista e ter confirmação.
7. Avisar o que mudou de nome de coluna e o que ficou de fora.

## 10. Regras de segurança

- Senha de banco/FTP e token: a **pessoa** digita/cola (formulário ou arquivo `.env.*.local`, ignorado pelo git).
- Nada de credencial em código, commit, URL ou log.
- Apagar tabela ou fonte extract é **definitivo** (a tabela física vai junto): mostre a lista e confirme antes.
- Push na `master` vai para produção: confirme com a pessoa antes de cada push.
- Tabelas de usuário/login do ERP (ex.: `D6_USUARIOS` com `D6_SENHA`/`D6_TOKEN`) expõem dados sensíveis a quem
  acessa o projeto — avise.
