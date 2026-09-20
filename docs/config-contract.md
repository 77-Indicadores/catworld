# Contrato de configuração

**Worker: nenhuma configuração vem do ambiente** (nem como fallback). Fonte única: o banco, editado em *Configurações > Worker*. Sem valor salvo, ou com valor inválido, vale o **padrão do código**. Detalhes em `docs/worker-architecture.md`.

| Chave (`cw_system_settings`) | Padrão | Faixa | Vale |
|---|---|---|---|
| `worker.max_heavy_jobs` | 2 | 1-20 | 10 s |
| `worker.max_syncs_per_storage` | 3 | 1-20 | 10 s |
| `worker.import_batch_delay_ms` | 200 | 0-5000 | 10 s |
| `upload.max_bytes` | 500 MB | 1 MB-2 GB | próximo envio |
| `upload.xlsx_max_bytes` | 40 MB | 1 MB-2 GB | próximo envio |
| `worker.stop_timeout_ms` | 600000 (10 min) | 1 s-60 min | supervisor |
| `worker.backoff_max_ms` | 60000 | 1-600 s | supervisor |
| `sql_contract.mode` | fallback | off/shadow/fallback/strict | 30 s |
| `result.normalize_default` | legacy | legacy/normalized | 30 s |
| `pg_isolation.mode` | enforce | enforce/off | — |

Por processo (tabela `cw_worker_profiles`, tela Workers): tipos de job e paralelismo (após reiniciar o worker), intervalo de busca e memória do DuckDB (10 s), habilitado.

O teto de corpo do proxy do Next (`next.config.ts`) é um valor de build fixo (2 GB); o limite real de upload é o da tabela acima, aplicado pela rota.

## Variáveis de ambiente (só infraestrutura e segredos)

`CATWORLD_DATABASE_URL`, `CATWORLD_ENCRYPTION_KEY`, `AUTH_SECRET`, `CATWORLD_UPLOAD_DIR` (caminho do volume), `CATWORLD_PUBLIC_ORIGIN` (URL pública). Elas precisam existir antes de o banco estar acessível, por isso não moram nele.

As envs de worker antigas (`CATWORLD_WORKER_*`, `_JOB_POLL_MS`, `_DUCKDB_MEMORY_LIMIT`, `_IMPORT_BATCH_DELAY_MS`, `_MAX_HEAVY_JOBS`, `_MAX_SYNCS_PER_STORAGE`, `_UPLOAD_MAX_BYTES`, `_XLSX_MAX_BYTES`) são ignoradas e listadas num aviso no boot; um teste impede que voltem ao código.
