# Provider genérico: banco Firebird recebido via FTP (backup .PLV)

Desenho para `/goal` — origem: cliente deposita periodicamente, num FTP, um ZIP contendo um backup (`gbak`) de um
banco Firebird. Precisamos extrair tabelas/queries dele para o Catworld, do mesmo jeito que já fazemos com
Postgres/SQL Server, **sem** um cron por tabela e **sem** hardcodar isso para um cliente específico.

## 0. O que existe hoje (referência do FTP real, TMK)

Sondado com leitura apenas (`curl --list-only`, sem baixar o arquivo inteiro):

```
ftp://194.238.31.66:2521/
├── ExportaQueries/        # mecanismo atual (CSV), já em uso
├── ExportaQueries_OLD/
└── PLV/
    └── TERMAQ.PLV.zip     # 1.702.423.156 bytes, modificado 2026-09-22 07:37
```

O ZIP contém um único arquivo `TERMAQ.PLV` (confirmado pelo cabeçalho local do ZIP, sem baixar tudo: método de
compressão *deflate*, tamanho desconhecido no cabeçalho — indício de que foi gerado por um processo que grava
e comprime em streaming, tipo o "Cobian Reflector" cujo arquivo de teste também está na pasta). `.PLV` não é uma
extensão padrão do Firebird (o nativo é `.fbk`/`.gbk`) — é só o nome que esse cliente deu ao backup; o conteúdo
é o formato de backup do `gbak`, como você confirmou.

**Não teste esse FTP com credenciais fixas em nenhum lugar do código.** As credenciais que você mandou no chat
são só para desenho; a implementação lê de `Connection.encryptedCredentials`, como todo o resto.

## 1. Por que isso não é só "mais um provider igual Postgres/MSSQL"

Hoje, origem = `postgres` ou `mssql`, e "conectar" é instantâneo (abrir um socket TCP e autenticar). O código
trata isso com `if (connection.provider === "mssql") {...} else {...}` espalhado em ~6 lugares
(`src/server/connections/sources.ts:280,428,496`, `src/server/connections/live.ts:11,30`) — não há interface.

Para Firebird-via-FTP, "conectar" tem 4 passos caros e assíncronos, que **não podem rodar por tabela**:

1. Checar se o arquivo no FTP mudou (tamanho + data — nunca baixar 1,7 GB só para comparar hash).
2. Baixar o ZIP, descompactar, achar o backup dentro.
3. Restaurar com `gbak -c` num banco Firebird efêmero, local, só-nosso.
4. Só então dá para rodar SQL contra ele.

> **Atualizado (2026-09-22, testado contra Firebird 3.0.8 real, Debian/Ubuntu):** um único servidor Firebird
> atende vários `.fdb` ao mesmo tempo — um cliente conecta direto pelo caminho do arquivo, sem precisar
> registrar alias. Então o passo 3 **não sobe/derruba processo de servidor por conexão**: existe um servidor
> Firebird único, sempre no ar na imagem (`CATWORLD_FIREBIRD_HOST`/`_PORT`, senha do SYSDBA em
> `CATWORLD_FIREBIRD_SYSDBA_PASSWORD` — segredo NOSSO, nunca a credencial do cliente), e o job só cria/apaga
> arquivos `.fdb` distintos nele. Implementado em `src/server/connections/firebird-materialize.ts` (trava por
> CAS otimista em `status`, não advisory lock — evita prender uma conexão do pool de Postgres pelos minutos
> que o download+gbak levam) e `src/server/connections/firebird.ts` (leitura via `node-firebird`).

Uma `DatasetSource` (tabela ou query configurada) continua tendo seu próprio `refreshCron`, como hoje — isso
**não muda o schema de agendamento**. O que muda é que os passos 1-3 acontecem **uma vez por conexão**, com
cache, e todas as fontes daquela conexão que estiverem "devidas" na mesma leva reaproveitam o mesmo banco
restaurado. Se o arquivo do FTP não mudou desde a última vez, nenhuma fonte baixa nada — só reabre (ou reusa)
o Firebird já restaurado, se ainda estiver de pé dentro do TTL.

## 2. Peças novas

### 2.1 Schema (Prisma, migração aditiva)

`Connection.provider = "firebird-ftp"` (a allowlist em `sources.ts:280` ganha esse valor). Config específica do
provider fica em `Connection.metadataJson` (campo já existe, livre, `@db.Text`), formato:

```json
{
  "ftp": { "host": "194.238.31.66", "port": 2521, "remotePath": "/PLV", "filePattern": "*.zip" },
  "firebird": { "innerFilePattern": "*.PLV", "charset": "WIN1252" }
}
```

`Connection.username`/`encryptedCredentials` reaproveitados para usuário/senha do FTP (mesma criptografia
AES-256-GCM já usada por Postgres/MSSQL — nenhuma mudança em `src/server/security/crypto.ts`).

Novo modelo `ConnectionMaterialization` (1:1 com `Connection`, só para providers baseados em arquivo):

```prisma
model ConnectionMaterialization {
  connectionId      String   @id @db.Uuid
  connection        Connection @relation(fields: [connectionId], references: [id], onDelete: Cascade)
  remoteSignature   String?  // "<tamanho>:<mtime ISO>" do arquivo remoto na última materialização OK
  materializedAt    DateTime?
  expiresAt         DateTime?  // TTL curto (ex.: 15 min) — janela em que outra fonte da mesma conexão reaproveita
  status            String   @default("idle") // idle | materializing | ready | failed
  firebirdHost      String?  // localhost; porta efêmera do servidor Firebird restaurado
  firebirdPort      Int?
  firebirdPath      String?  // caminho do .fdb restaurado (para DROP DATABASE ao expirar)
  lastError         String?  @db.Text
  updatedAt         DateTime @updatedAt
  @@map("cw_connection_materializations")
}
```

Por que uma tabela à parte e não campos direto em `Connection`: mantém `Connection` genérica (Postgres/MSSQL
nunca preenchem isso) e dá um lugar natural para uma trava (`status='materializing'`) sem sujar o schema de todo
mundo. É a mesma lógica de separar `StorageServer` de `Dataset`.

### 2.2 Job novo + lane dedicada

`Job.type = "CONNECTION_MATERIALIZE"`, payload `{ connectionId }`. Peso sempre pesado (nova entrada em
`classifySourceLane`/`laneWeight`, `sources.ts:114-124`), rodando só em workers cujo `WorkerProfile.jobTypes`
inclua esse tipo — um perfil novo (ex. `worker-firebird`) com mais disco/memória reservados, para não competir
com os workers rápidos de hoje. Isso segue o padrão que já existe (`worker-sync-long-*` já é um perfil dedicado
a refreshes demorados).

Fluxo do job:
1. `withAdvisoryLock` por `connectionId` (mesmo padrão de `queueSourceRefresh`) — nunca duas materializações da
   mesma conexão em paralelo.
2. Lista o diretório remoto via FTP, pega tamanho+data do arquivo mais recente que bate o `filePattern`.
3. Compara com `remoteSignature` salvo. Igual → marca `status='ready'`, atualiza só `expiresAt`, sai (rápido).
4. Diferente → baixa para um diretório de trabalho descartável (não o disco efêmero do worker de imports),
   descompacta, roda `gbak -c -user ... -role ...` restaurando num `.fdb` novo, sobe um processo `fb_smp_server`
   (ou usa o serviço Firebird já rodando na imagem, com um alias novo) **bindado só em localhost**, numa porta
   livre. Grava host/porta/caminho em `ConnectionMaterialization`, `status='ready'`, `expiresAt = now + TTL`.
5. **Sempre libera em `finally`**: se falhar em qualquer ponto, apaga arquivos parciais (mesmo princípio da
   guarda de staging parcial que já existe no import de upload — nunca deixar lixo pela metade).
6. Ao expirar o TTL (checado pelo próprio `enqueueDue`/recovery loop), um job de limpeza para o Firebird efêmero
   e apaga o `.fdb` e o ZIP baixado. Enquanto uma fonte estiver ativamente lendo dele, o TTL é renovado (mesmo
   princípio de heartbeat que já existe no lease de import).

`refreshDatasetSource` (`sources.ts:415`), ao ver `connection.provider === "firebird-ftp"`, primeiro garante que
existe uma materialização `ready` e não vencida (chamando o mesmo caminho do passo acima de forma síncrona se
necessário, com um lock próprio para não duplicar); só depois lê linhas dela via o adapter novo (§2.3).

### 2.3 Adapter de origem

Novo arquivo `src/server/connections/firebird.ts`, espelhando a forma de `postgres.ts`/`mssql.ts` (mesmo padrão
de hoje, não uma reescrita de Postgres/MSSQL para uma interface polimórfica — isso seria um refactor grande e
arriscado, fora do escopo deste `/goal`): `testFirebird`, `listSchemasFirebird` (Firebird não tem schema — só
tabelas/views no banco), `listTablesFirebird`, `tableColumnsFirebird`, `queryColumnsFirebird`,
`executeFirebirdReadOnly`, `streamFirebirdRows`, `quotedFirebirdTable`, `sourceClockFirebird`,
`safeStatementFirebird` — usando o driver `node-firebird` (puro JS, maduro, compatível com FB 2.5+; para FB 3.0
mais antigo pode exigir `AuthServer = Legacy_Auth` / `WireCrypt = Disabled` no `firebird.conf` do servidor
efêmero — deixamos essas duas linhas fixas na config do nosso Firebird interno para maximizar compatibilidade
com backups de versões antigas, já que não controlamos a versão de origem do cliente).
Os ~6 call sites em `sources.ts`/`live.ts` ganham mais um branch (`isFirebird = connection.provider ===
"firebird-ftp"`), do jeito que `isMssql` já existe hoje — consistente com o padrão atual, sem inventar
abstração nova ali.

Tipos: Firebird tem `NUMERIC(p,s)`/`DECIMAL(p,s)` exatos (igual ao trabalho já feito para upload/fontes SQL —
reaproveita `parseDecimalType`/fidelidade decimal), `BLOB SUB_TYPE 1` (texto longo) e `BLOB SUB_TYPE 0`
(binário), `TIMESTAMP` sem fuso. Charset do banco de origem importa (`WIN1252` é comum em ERPs Firebird
brasileiros antigos) — vira parâmetro de conexão do driver, não adivinhado.

### 2.4 Camada de FTP (genérica, não específica de Firebird)

Novo módulo `src/server/connections/ftp-watch.ts`: cliente FTP (lib `basic-ftp`, MIT, madura, promises nativas —
nenhuma dependência de FTP existe hoje) com duas funções puras, reutilizáveis por qualquer futuro provider
"baseado em arquivo remoto" (não só Firebird):

- `statRemoteFile(conn, path, pattern) -> { name, size, mtime }` — só `LIST`, nunca baixa.
- `downloadRemoteFile(conn, path, destPath)` — baixa com retomada em caso de queda (basic-ftp suporta), nunca
  sobrescreve um arquivo incompleto no lugar final (baixa em `.part`, renomeia só no sucesso — mesmo princípio
  de "staging nunca é o arquivo final" que já vale para o SQL Server).

Assim, se amanhã aparecer outro cliente com outro banco (MySQL dump, SQLite, outro Firebird) chegando por FTP, o
"vigiar o FTP + decidir se mudou + baixar com segurança" já está pronto; só o "materializar" (passos 3-4 do
job) muda por tipo de arquivo.

### 2.5 Docker / infraestrutura

`Dockerfile`: adicionar `firebird3.0-utils` (traz `gbak`, e via dependência `libfbclient2`) e, se optarmos por
subir um servidor de verdade (decidido: sim), `firebird3.0-server` também — pacotes Debian bookworm confirmados
([packages.debian.org](https://packages.debian.org/source/bookworm/firebird3.0)). O serviço Firebird do pacote
não deve ficar sempre no ar como daemon do sistema; o job de materialização sobe/derruba a instância que
restaura cada backup (ou usa `fbguard`/`fb_smp_server` apontado para um `firebird.conf` mínimo, só localhost).

`package.json`: `node-firebird` (driver) e `basic-ftp` (cliente FTP). Nenhuma outra dependência nova.

### 2.6 Disco e limites (o risco real desse desenho)

1,7 GB comprimido por cliente por ciclo, e o `.fdb` restaurado pode ser maior ainda. Isso **não pode** rodar no
mesmo disco efêmero que hoje serve imports/staging de upload, sob risco de um cliente Firebird grande derrubar
import de outro cliente por falta de espaço. Preciso que você confirme (infra, fora do meu alcance daqui):

- Tem um volume dedicado (ou pelo menos com quota reservada) para isso no host de produção?
- Qual o teto realista de espaço por ciclo (esse cliente sozinho já usa ~4-6 GB de pico: zip + backup
  descompactado + `.fdb` restaurado, se mantivermos os três simultâneos por segurança até confirmar sucesso)?

Enquanto isso não estiver confirmado, o job de materialização recusa rodar se o espaço livre do volume alvo
cair abaixo de um piso configurável (mesmo princípio defensivo do resto do plano de confiabilidade: nunca
estourar recurso em silêncio).

## 3. O que fica igual (reaproveitado sem mudança)

- Barra de integridade (`evaluateLoad`), guarda de queda/vazio, exactly-once, tipos só alargam, `_cw_rh`,
  `rows?since=` — tudo isso já é do lado "storage/merge", independente de onde a fonte veio. Uma vez que o
  adapter Firebird devolve linhas, o resto do pipeline de `refreshDatasetSource` (staging → swap atômico →
  ledger) não muda uma linha.
- Cron por `DatasetSource`, tela de configuração de fonte, watermark incremental (`deltaColumn`) — tudo segue
  igual; o usuário configura uma fonte "Firebird" exatamente como configura uma fonte Postgres hoje, só que
  aponta pra uma `Connection` do tipo novo.

## 4. Ordem de implementação sugerida

1. Migração Prisma (`Connection.provider` aceita `firebird-ftp`; tabela `cw_connection_materializations`).
2. `ftp-watch.ts` (genérico) + teste contra o FTP real do TMK (só leitura/listagem nos testes automatizados;
   download completo só manual, uma vez, para validar o `gbak restore`).
3. Docker: instalar `firebird3.0-server`/`firebird3.0-utils`, provar `gbak -c` restaurando o backup real do TMK
   localmente (WSL, do jeito que já fizemos para o SQL Server de teste).
4. `firebird.ts` (adapter) + branch novo em `sources.ts`/`live.ts`.
5. Job `CONNECTION_MATERIALIZE` + perfil de worker dedicado + limite de disco.
6. UI: tipo de conexão novo no formulário (host/porta/usuário/senha de FTP + caminho remoto).
7. Teste de ponta a ponta com o backup real do TMK antes de qualquer coisa em produção.

## 5. Decisões já tomadas com você (2026-09-22)

- Motor de consulta: Firebird real (gbak + servidor efêmero) + driver `node-firebird`, não `isql` texto.
- Agendamento: cron continua por `DatasetSource`; cache de materialização por `Connection` com TTL evita
  redownload/redownload por tabela.
- Execução pesada: lane/perfil de worker dedicado, não os workers de hoje.
- Protocolo: só FTP por enquanto (código do FTP isolado o bastante para um SFTP entrar depois sem redesenho).
