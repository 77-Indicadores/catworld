# Contrato de configuracao

Precedencia (maior primeiro): painel (`cw_system_settings`) > variavel de ambiente > default do codigo.
Valor invalido no painel/banco (texto, fora da faixa) e ignorado e cai no env (nunca vira NaN/0).

| Chave no painel | Env | Default | Faixa |
|---|---|---|---|
| `worker.max_heavy_jobs` | `CATWORLD_MAX_HEAVY_JOBS` | 2 | 1-20 |
| `worker.max_syncs_per_storage` | `CATWORLD_MAX_SYNCS_PER_STORAGE` | 3 | 1-20 |
| `worker.import_batch_delay_ms` | `CATWORLD_IMPORT_BATCH_DELAY_MS` | 200 | 0-5000 |
| `sql_contract.mode` | — | fallback | off/shadow/fallback/strict |
| `result.normalize_default` | — | legacy | legacy/normalized |
| `pg_isolation.mode` | — | enforce | enforce/off |

So env (exige restart): `CATWORLD_WORKER_CONCURRENCY`, `CATWORLD_WORKER_ID`, `CATWORLD_WORKER_JOB_TYPES` (tipos desconhecidos geram aviso no log),
`CATWORLD_JOB_POLL_MS`, `CATWORLD_UPLOAD_MAX_BYTES`, `CATWORLD_XLSX_MAX_BYTES` (default 40MB), `CATWORLD_DUCKDB_MEMORY_LIMIT`.
O worker relê o painel a cada 10s; a web invalida seu cache local ao salvar.
