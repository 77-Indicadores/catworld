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
    print(result["rows"])
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

```python
{
    "columns": ["col1", "col2", ...],
    "rows": [{"col1": ..., "col2": ...}, ...],
    "rowCount": 4923,
    "truncated": False,       # True se o resultado foi cortado pelo limit
    "executionTimeMs": 312,
}
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

### `upload(path, dataset_id, mode="replace", key_column=None, poll_interval=2)`

Envia um arquivo para um dataset.

```python
result = client.upload(
    "dados.xlsx",
    dataset_id="<dataset-id>",
    mode="replace",       # "replace" sobrescreve, "append" adiciona, "upsert" atualiza/insere
    key_column="id",      # obrigatório para mode="upsert"
)
print(result["status"], result["rowCount"])
```

O método aguarda até a importação ser concluída. O arquivo pode ser `.csv`, `.xlsx` ou `.xls`.

**Parâmetros:**

| Parâmetro | Tipo | Padrão | Descrição |
|---|---|---|---|
| `path` | `str \| Path` | — | Caminho do arquivo local |
| `dataset_id` | `str` | — | ID do dataset de destino |
| `mode` | `str` | `"replace"` | Modo de importação: `replace`, `append` ou `upsert` |
| `key_column` | `str` | `None` | Coluna chave para `mode="upsert"` |
| `poll_interval` | `float` | `2` | Intervalo de polling em segundos |

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
    print(t["name"], [c["sqlName"] for c in t["columns"]])
```

---

### `rows(table_id, limit=100)`

Retorna as primeiras linhas de uma tabela pelo ID.

```python
rows = client.rows("<table-id>", limit=50)
print(rows)
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
