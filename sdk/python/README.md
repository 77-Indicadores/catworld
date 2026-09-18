# catworld-sdk

Cliente oficial Python para a API Catworld.

## Instalação

```bash
pip install catworld-sdk
```

## Início rápido

```python
from catworld import CatworldClient

with CatworldClient("https://seu-catworld.exemplo.com", "cw_live_...") as client:
    result = client.query("SELECT * FROM banco_horas", dataset_id="<dataset-id>")
    df = result.dataframe
    print(df.head())
```

## Autenticação

Passe a URL base do seu Catworld e um token de API gerado na interface:

```python
client = CatworldClient(
    base_url="https://seu-catworld.exemplo.com",
    token="cw_live_...",
    timeout=30,  # timeout padrão das requisições HTTP (segundos)
)
```

Use como context manager (`with`) para fechar a conexão automaticamente, ou chame `client.close()` manualmente.

## Métodos

### `query(sql, dataset_id=None, project_id=None, timeout=30, limit=10000)`

Executa uma query SQL somente leitura.

**Contexto de schema** — passe `dataset_id` ou `project_id` para que o servidor resolva automaticamente tabelas não qualificadas para o schema correto:

```python
# Com dataset_id: resolve tabelas do schema desse dataset
result = client.query("SELECT * FROM banco_horas", dataset_id="<dataset-id>")

# Com project_id: resolve tabelas de qualquer dataset do projeto
result = client.query("SELECT * FROM banco_horas", project_id="<project-id>")

# Sem contexto: você precisa qualificar manualmente com schema.tabela
result = client.query("SELECT * FROM meu_schema.banco_horas")
```

Se a mesma tabela existir em mais de um schema do contexto informado, o servidor retorna erro pedindo que você qualifique com `schema.tabela`.

**Retorno:**

`query` retorna um `QueryResult`: ele funciona como `dict` para compatibilidade, mas tambem expoe `.rows`, `.columns` e `.dataframe`.

```python
result = client.query("SELECT * FROM banco_horas", dataset_id="<dataset-id>")

rows = result.rows
columns = result.columns
df = result.dataframe
```

Para usar `.dataframe`, instale o extra com pandas:

```bash
pip install "catworld-sdk[dataframe]"
```

**Parâmetros:**

| Parâmetro | Tipo | Padrão | Descrição |
|---|---|---|---|
| `sql` | `str` | — | Query SQL (apenas SELECT/WITH) |
| `dataset_id` | `str` | `None` | ID do dataset para resolver schemas |
| `project_id` | `str` | `None` | ID do projeto para resolver schemas |
| `timeout` | `int` | `30` | Timeout da query no servidor (segundos, máx. 120) |
| `limit` | `int` | `10000` | Número máximo de linhas retornadas |

---

### `upload(path, dataset_id, mode="replace", key_column=None, table_id=None, column_types=None, wait=False, poll_interval=2, timeout=None, skip_preflight=False, full_snapshot=False)`

Envia um arquivo para um dataset.

```python
result = client.upload(
    "dados.xlsx",
    dataset_id="<dataset-id>",
    table_id="<table-id>",  # recomendado sempre que o nome do arquivo pode variar
    mode="replace",         # "replace" sobrescreve, "append" adiciona, "upsert" atualiza/insere
    key_column="id",        # obrigatório para mode="upsert"
    wait=True,               # recomendado — veja abaixo
)
print(result["status"], result["rowCount"])
```

Com `mode="upsert"`, use `full_snapshot=True` só se o arquivo enviado representa 100% do estado atual da origem a cada envio (não um lote parcial/janela) — isso habilita detecção de exclusão: linhas que existiam antes e não aparecem mais no arquivo são marcadas como excluídas, e passam a aparecer em `changes(...)["removedKeys"]`. Default `False`.

⚠️ **Por padrão (`wait=False`) este método NÃO informa se a importação deu certo.** Ele retorna assim que o arquivo é enfileirado — preview e import rodam em background, e um erro de schema, por exemplo, só aparece depois, olhando `get_upload(upload_id)` ou o painel. **Recomendamos fortemente `wait=True`** em qualquer script que precise saber o resultado: com isso, o método bloqueia até o import terminar (poll em `GET /api/v1/uploads/{id}`) e levanta `UploadError` com a mensagem de erro real do servidor se falhar (ex: `"Schema incompatível. Esperado: ..."`) — em vez de falhar em silêncio.

O arquivo pode ser `.csv`, `.xlsx` ou `.xls`.

**Pré-checagens automáticas (desde 0.6.0)** — sempre que `table_id` é informado e `mode` é `"append"` ou `"upsert"`, `upload()` valida localmente *antes de enviar qualquer byte*:

- `mode="upsert"` sem `key_column` falha na hora, sem gastar banda.
- Para arquivos `.csv`, os cabeçalhos são comparados com o schema físico da tabela (mesma checagem de `check_append_compat`) — pega o erro mais comum de append/upsert de graça. Para `.xlsx`/`.xls` essa parte é pulada (chame `check_append_compat` manualmente se quiser essa cobertura).
- Em `mode="upsert"`, também confere que `key_column` existe na tabela e **ainda é única nela hoje** (`check_upsert_ready`) — sem isso, uma chave que já não é única na tabela de destino (por exemplo, populada antes por um `append`) faria o upsert mesclar essas duplicatas silenciosamente pra sempre.

Passe `skip_preflight=True` para pular essas checagens (por exemplo, se alguma delas der falso positivo no seu caso).

**Parâmetros:**

| Parâmetro | Tipo | Padrão | Descrição |
|---|---|---|---|
| `path` | `str \| Path` | — | Caminho do arquivo local |
| `dataset_id` | `str` | — | ID do dataset de destino |
| `mode` | `str` | `"replace"` | Modo de importação: `replace`, `append` ou `upsert` |
| `key_column` | `str` | `None` | Coluna chave para `mode="upsert"` |
| `table_id` | `str` | `None` | Tabela de destino. Sem isso, o nome vem do nome do arquivo — passe sempre que o nome puder variar entre execuções |
| `column_types` | `dict[str, str]` | `None` | Sobrepõe o tipo SQL auto-detectado para colunas específicas — veja abaixo |
| `wait` | `bool` | `False` | **Recomendado `True`.** Bloqueia até o import terminar e levanta exceção se falhar |
| `poll_interval` | `float` | `2` | Intervalo de polling em segundos (só com `wait=True`) |
| `timeout` | `float` | `None` | Tempo máximo de espera em segundos (só com `wait=True`); `None` = sem limite |
| `skip_preflight` | `bool` | `False` | Pula as pré-checagens locais descritas acima |

**Sobrepondo o tipo de uma coluna (`column_types`)**

O servidor infere o tipo SQL de cada coluna olhando uma amostra do arquivo a cada upload — isso pode divergir entre execuções (ex: uma coluna maiormente vazia vira texto numa carga e data em outra), quebrando `append`/`upsert` com `Schema incompatível` mesmo sem mudança real de dado. Use `column_types` para fixar o tipo de uma coluna manualmente:

```python
client.upload(
    "vendas.csv",
    dataset_id="<dataset-id>",
    table_id="<table-id>",
    mode="append",
    column_types={"data_venda": "DATE", "valor": "DECIMAL(18,2)"},
)
```

Tipos aceitos: `BIGINT`, `DECIMAL(p,s)` (ex: `DECIMAL(18,2)`), `DATE`, `DATETIME2`, `TIME`, `NVARCHAR(MAX)`. A chave é o nome da coluna (cabeçalho original ou já normalizado); um override com nome ou tipo desconhecido é ignorado silenciosamente pelo servidor (não derruba o upload).

**Erros comuns e como evitá-los:**

| Erro | Causa | Como evitar |
|---|---|---|
| `Schema incompatível. Esperado: ...; atual: ...` | `append`/`upsert` com colunas diferentes (nome, ordem ou presença) da tabela já existente | A partir de 0.6.0 isso é pego automaticamente pela pré-checagem, antes do upload; garanta cabeçalhos estáveis entre execuções |
| `Schema incompatível: tipos da tabela atual diferem do arquivo` | Uma coluna que antes era só números agora tem texto/decimal (ou vice-versa) — o tipo é reinferido a cada arquivo | Use `column_types` para fixar o tipo da coluna, ou garanta que a exportação de origem produza o mesmo tipo sempre |
| `Coluna-chave '...' já não é única na tabela de destino` | `mode="upsert"` com uma `key_column` que já tem valores duplicados na tabela (ex: populada antes por um `append`) | Pego automaticamente pela pré-checagem; limpe as duplicatas existentes na tabela antes de retomar o upsert |
| `Arquivo contém chaves duplicadas para upsert na coluna "..."` | O arquivo enviado tem a própria chave duplicada — a mensagem já traz uma amostra dos valores e quantas vezes cada um se repete | Deduplique o arquivo antes de subir, usando os valores listados no erro |
| `XLSX_TOO_LARGE` | Arquivo `.xlsx`/`.xls` acima do limite (XLSX é lido inteiro em memória) | Exporte como `.csv` para arquivos grandes |
| Upload nunca sai de `RETRYING`/`FAILED` sempre com o mesmo erro | Erro estrutural (schema), não transitório — retry não resolve | Corrija o schema (veja acima); um `mode="replace"` único recria a tabela do zero com as colunas novas, mas **descarta dados que não estejam no arquivo atual** |

---

### `get_upload(upload_id)`

Consulta o estado atual de um upload — útil com `wait=False`, ou pra checar um upload antigo.

```python
upload = client.get_upload(upload_id)
print(upload["status"], upload.get("errorMessage"))
```

---

### `check_append_compat(dataset_id, table_id, headers)`

Confere, **antes de enviar o arquivo**, se os cabeçalhos batem com o schema físico da tabela — pega o erro mais comum de `append`/`upsert` sem gastar tempo/banda subindo o arquivo primeiro. Aceita cabeçalhos crus (com acento, espaço, etc.) e normaliza internamente do mesmo jeito que o servidor.

```python
headers = ["Período Início", "Período Fim", "Relatório", "Posto", "Produto", "Total Abastecido"]
client.check_append_compat(dataset_id, table_id, headers)  # levanta ValidationError se não bater
client.upload("relatorio.xlsx", dataset_id=dataset_id, table_id=table_id, mode="append")
```

Só compara nomes e ordem de coluna — **não valida tipo de dado** (isso só o servidor descobre lendo o arquivo de verdade). Se a tabela ainda não existe (upload novo), não levanta erro.

Desde 0.6.0, `upload()` já chama isso automaticamente para arquivos `.csv` (veja "Pré-checagens automáticas" acima) — use este método diretamente só para `.xlsx`/`.xls`, ou pra checar antes de decidir o `table_id`.

---

### `check_upsert_ready(dataset_id, table_id, key_column)`

Confere, **antes de enviar o arquivo**, se `key_column` está pronta para `mode="upsert"`: existe na tabela e ainda não tem valores duplicados nela. O servidor só valida chave duplicada *no arquivo novo* — nunca na tabela já existente — então uma chave que já não é única na tabela de destino faria o upsert mesclar essas duplicatas silenciosamente pra sempre.

```python
client.check_upsert_ready(dataset_id, table_id, "documento")  # levanta ValidationError se a chave não existir ou já tiver duplicata
client.upload("clientes.csv", dataset_id=dataset_id, table_id=table_id, mode="upsert", key_column="documento")
```

Desde 0.6.0, `upload()` já chama isso automaticamente quando `mode="upsert"` (veja "Pré-checagens automáticas" acima) — use este método diretamente só se quiser rodar a checagem separadamente do upload, ou com `skip_preflight=True`.

---

### `projects()`

Lista todos os projetos acessíveis pelo token.

```python
projects = client.projects()
for p in projects:
    print(p["id"], p["name"])
```

---

### `datasets()`

Lista todos os datasets acessíveis pelo token.

```python
datasets = client.datasets()
for d in datasets:
    print(d["id"], d["name"], d["schemaName"])
```

---

### `tables(dataset_id)`

Lista as tabelas de um dataset com colunas e tipos.

```python
tables = client.tables("<dataset-id>")
for t in tables:
    origem = t.get("source")
    print(t["name"], origem["mode"] if origem else "catworld")
```

---

### `sources(dataset_id)`

Lista as fontes conectadas de um dataset.

```python
sources = client.sources("<dataset-id>")
for s in sources:
    print(s["id"], s["name"], s["mode"], s["connection"]["name"])
```

---

### `rows(table_id, limit=100)`

Retorna as primeiras linhas de uma tabela pelo ID.
Funciona tanto para tabelas materializadas no Catworld quanto para tabelas live; se a tabela for live, o servidor consulta o Postgres da fonte.

```python
rows = client.rows("<table-id>", limit=50)
print(rows)
```

---

### `changes(table_id, since=None, limit=1000)`

Puxa só o que mudou numa tabela **extract** desde a última vez — em vez de reler a tabela inteira a cada execução. Só funciona em tabelas alimentadas por conexão/upload incremental (upsert com coluna-chave); não funciona em fontes `live`.

Retorna `{"rows": [...], "removedKeys": [...] | None, "nextSince": str}`:

- `rows`: linhas novas ou atualizadas desde `since`.
- `removedKeys`: chaves excluídas na origem desde `since` — `None` se a fonte nunca teve `keyColumn` configurado (sem como saber o que foi excluído), ou sempre vazio se a fonte usa busca parcial por `deltaColumn` (nesse caso o Catworld não tem como distinguir "não mudou" de "foi excluído" — ver detecção de exclusão só se aplica a fontes com snapshot completo).
- `nextSince`: guarde esse valor e passe como `since` na próxima chamada. Se nada mudou, `nextSince` volta igual ao `since` enviado — seguro chamar em loop.

Exemplo de polling, guardando o cursor entre execuções (ex: um arquivo local ou uma tabela de controle):

```python
import json
from pathlib import Path

cursor_file = Path("cursor.json")
since = json.loads(cursor_file.read_text())["since"] if cursor_file.exists() else None

result = client.changes("<table-id>", since=since, limit=1000)
for row in result["rows"]:
    ...  # processa cada linha nova/atualizada

if result["removedKeys"]:
    for key in result["removedKeys"]:
        ...  # remove/marca como excluído localmente

cursor_file.write_text(json.dumps({"since": result["nextSince"]}))
```

---

### Tabelas live em `query`

Quando voce passa `dataset_id`, o SDK trata tabelas live como tabelas do dataset. Se a SQL referencia uma tabela live conhecida, `query` chama a fonte Postgres correta por baixo.

```python
result = client.query("SELECT * FROM clientes", dataset_id="<dataset-id>")
df = result.dataframe
print(df.head())
```

Queries que misturam uma tabela live com tabela interna/extract nao sao roteadas automaticamente, porque elas precisariam cruzar bancos diferentes. Nesses casos, materialize a fonte como extract ou consulte a fonte live separadamente.

---

### `live_query(source_id, sql=None, timeout=30, limit=10000)`

Executa uma consulta diretamente na fonte live Postgres. Normalmente prefira `query(..., dataset_id=...)`; este metodo fica disponivel para casos em que voce ja tem o ID da fonte.
Se `sql` for omitido, o servidor usa a consulta/tabela configurada na fonte.

```python
result = client.live_query("<source-id>", "SELECT TOP 100 * FROM clientes")
print(result.dataframe.head())
```

---

### `refresh_source(source_id)`

Enfileira uma atualização de uma fonte do tipo cópia no Catworld.

```python
job = client.refresh_source("<source-id>")
print(job["id"])
```

## Exceções

| Exceção | Quando ocorre |
|---|---|
| `catworld.ConnectionError` | Falha de rede ou erro inesperado do servidor |
| `catworld.AuthenticationError` | Token inválido, expirado ou revogado (HTTP 401) |
| `catworld.PermissionDeniedError` | Token sem permissão para a operação (HTTP 403) |
| `catworld.ValidationError` | Dados inválidos, SQL inseguro ou upload malformado (HTTP 400/422) |
| `catworld.QueryTimeoutError` | Query ou importação excedeu o tempo limite |

```python
from catworld import CatworldClient
from catworld.exceptions import PermissionDeniedError, QueryTimeoutError

try:
    result = client.query("SELECT * FROM banco_horas", dataset_id="<id>")
except PermissionDeniedError:
    print("Token sem acesso a este dataset")
except QueryTimeoutError:
    print("Query demorou demais, tente limitar com TOP ou WHERE")
```
