"""
Teste de stress via SDK — fluxo completo end-to-end:
  1. Upload de arquivo via SDK (POST /api/v1/uploads → PUT blob → POST uploaded)
  2. Poll de status até COMPLETED ou FAILED (worker processa em background)
  3. Verifica row count via query SQL
  4. Re-upload do mesmo arquivo na mesma tabela (replace)
  5. Re-upload com arquivo diferente na mesma tabela
  6. Verifica integridade em cada passo

Usage:
  python scripts/sdk-stress-test.py
"""

import sys
import io
import os
import time
import hashlib
import httpx
from pathlib import Path

# Força UTF-8 no stdout para evitar erros cp1252 no terminal Windows
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).parent.parent / "sdk" / "python" / "src"))
from catworld import CatworldClient

BASE_URL   = os.getenv("CATWORLD_BASE_URL", "http://localhost:3000")
TOKEN      = os.getenv("CATWORLD_TOKEN", "")
DATASET_ID = os.getenv("CATWORLD_DATASET_ID", "")

if not TOKEN:
    print("ERRO: defina CATWORLD_TOKEN=<seu_token>")
    sys.exit(1)
if not DATASET_ID:
    print("ERRO: defina CATWORLD_DATASET_ID=<dataset_id>")
    sys.exit(1)
OUTPUT_DIR = Path("C:/Users/TRABALHO/Documents/output")

POLL_INTERVAL = 4    # segundos entre polls
POLL_TIMEOUT  = 600  # segundos máximo de espera

# Arquivos de teste: (arquivo, rows_esperados)
TEST_FILES = [
    ("clientes.csv",               2040),
    ("Faturamento.csv",            9213),
    ("movimentacoes_financeiras.csv", 14222),
    ("Compras 329.csv",            53219),
]


def poll_upload(client_raw: httpx.Client, upload_id: str, label: str) -> dict:
    """Poll GET /api/v1/uploads até status COMPLETED ou FAILED."""
    deadline = time.time() + POLL_TIMEOUT
    dots = 0
    while time.time() < deadline:
        resp = client_raw.get(f"/api/v1/uploads")
        resp.raise_for_status()
        uploads = resp.json()["data"]
        u = next((x for x in uploads if x["id"] == upload_id), None)
        if u is None:
            raise RuntimeError(f"Upload {upload_id} não encontrado")
        status = u.get("status", "")
        if status == "COMPLETED":
            print(f" → COMPLETED (rowCount={u.get('rowCount')})")
            return u
        if status == "FAILED":
            raise RuntimeError(f"Upload FAILED: {u.get('errorMessage', '?')}")
        dots += 1
        if dots % 5 == 0:
            print(f"   [{label}] status={status}...", flush=True)
        time.sleep(POLL_INTERVAL)
    raise TimeoutError(f"Upload {upload_id} não completou em {POLL_TIMEOUT}s")


def get_row_count(cw: CatworldClient, dataset_id: str, table_sql_name: str) -> int:
    """Conta rows físicos via query SQL."""
    # Pega o schema name do dataset
    ds = next((d for d in cw.datasets() if d["id"] == dataset_id), None)
    if not ds:
        raise RuntimeError(f"Dataset {dataset_id} não encontrado")
    schema = ds.get("schemaName", "dbo")
    result = cw.query(
        f'SELECT COUNT_BIG(*) AS n FROM [{schema}].[{table_sql_name}]',
        timeout=30,
        dataset_id=dataset_id,
    )
    return int(result.rows[0]["n"])


def run_test(
    cw: CatworldClient,
    raw: httpx.Client,
    file_path: Path,
    expected_rows: int,
    dataset_id: str,
    table_id: str | None = None,
    label: str = "",
) -> tuple[str, str, int]:  # (upload_id, table_id, physical_rows)
    """Faz o upload via SDK, aguarda COMPLETED, retorna (upload_id, table_id, physical_rows)."""
    print(f"  [{label}] Enviando {file_path.name} ({file_path.stat().st_size // 1024}KB)...", end=" ", flush=True)
    upload_info = cw.upload(str(file_path), dataset_id=dataset_id, mode="replace", table_id=table_id)
    upload_id = upload_info["id"]

    completed = poll_upload(raw, upload_id, label)

    # tableId vem do upload completado
    resolved_table_id = completed.get("tableId") or upload_info.get("tableId") or table_id
    if not resolved_table_id:
        raise RuntimeError(f"Sem tableId no upload {upload_id}")

    # Pega sqlName da tabela para query
    tables = cw.tables(dataset_id)
    table = next((t for t in tables if t["id"] == resolved_table_id), None)
    if not table:
        raise RuntimeError(f"Tabela não encontrada para upload {upload_id}")

    physical = get_row_count(cw, dataset_id, table["sqlName"])
    match = "✓" if physical == expected_rows else f"✗ (esperado {expected_rows})"
    print(f"  física={physical} {match}")

    return upload_id, resolved_table_id, physical


def main():
    print(f"=== SDK Stress Test — {BASE_URL} ===\n")

    cw = CatworldClient(base_url=BASE_URL, token=TOKEN, timeout=60)
    raw = httpx.Client(
        base_url=BASE_URL,
        headers={"Authorization": f"Bearer {TOKEN}"},
        timeout=30,
    )

    # Verifica conectividade
    try:
        datasets = cw.datasets()
        ds = next((d for d in datasets if d["id"] == DATASET_ID), None)
        if not ds:
            print(f"ERRO: dataset {DATASET_ID} não encontrado. Datasets disponíveis:")
            for d in datasets:
                print(f"  {d['id']} — {d.get('name')}")
            sys.exit(1)
        print(f"Dataset: {ds.get('name')} (schema={ds.get('schemaName')})\n")
    except Exception as e:
        print(f"ERRO ao conectar: {e}")
        sys.exit(1)

    results = []

    for filename, expected_rows in TEST_FILES:
        fp = OUTPUT_DIR / filename
        if not fp.exists():
            print(f"  SKIP: {filename} não encontrado")
            continue

        print(f"\n{'='*60}")
        print(f"Arquivo: {filename} | esperado: {expected_rows} rows")
        print(f"{'='*60}")

        try:
            # ── 1º upload (import inicial) ─────────────────────────────
            _uid1, table_id, p1 = run_test(cw, raw, fp, expected_rows, DATASET_ID, table_id=None, label="1º import")

            # ── 2º upload (re-upload mesma tabela, mesmo arquivo) ──────
            _uid2, table_id, p2 = run_test(cw, raw, fp, expected_rows, DATASET_ID, table_id=table_id, label="re-upload mesmo arquivo")

            # ── 3º upload (re-upload com arquivo diferente) ────────────
            # Usa o próximo arquivo disponível como substituto
            alt_files = [f for f, _ in TEST_FILES if f != filename and (OUTPUT_DIR / f).exists()]
            if alt_files:
                alt_path = OUTPUT_DIR / alt_files[0]
                alt_rows = dict(TEST_FILES)[alt_files[0]]
                _uid3, _, p3 = run_test(cw, raw, alt_path, alt_rows, DATASET_ID, table_id=table_id, label=f"re-upload arquivo diferente ({alt_files[0]})")
                # Restaura com o arquivo original
                _uid4, _, p4 = run_test(cw, raw, fp, expected_rows, DATASET_ID, table_id=table_id, label="restore original")

            ok = (p1 == expected_rows) and (p2 == expected_rows)
            results.append((filename, expected_rows, p1, p2, ok))

        except Exception as e:
            print(f"  ERRO: {e}")
            results.append((filename, expected_rows, -1, -1, False))

    # ── Sumário ────────────────────────────────────────────────────────
    print(f"\n{'='*60}")
    print("SUMÁRIO")
    print(f"{'='*60}")
    passed = sum(1 for *_, ok in results if ok)
    print(f"Passaram: {passed}/{len(results)}\n")
    for filename, expected, p1, p2, ok in results:
        status = "✓" if ok else "✗"
        print(f"  {status} {filename}")
        print(f"       esperado={expected} | 1ºimport={p1} | re-upload={p2}")

    if passed < len(results):
        sys.exit(1)


if __name__ == "__main__":
    main()
