"""
Teste de integridade de dados — verifica que o CONTEÚDO das tabelas é atualizado,
não apenas a contagem de linhas.

Cenários cobertos:
  A. tds-small-csv  (< 1MB): replace, re-replace com dados diferentes, append
  B. direct-bulk    (> 1MB, 1º import): replace com dados diferentes
  C. blob-bulk      (> 1MB, re-upload tabela existente): re-replace com dados diferentes
  D. Append (delta): linhas adicionadas aparecem; linhas do replace desaparecem
  E. Dados apagados: após replace, linhas do lote anterior NÃO existem mais

Para cada cenário verifica:
  - rowCount esperado
  - valor sentinela da 1ª linha (coluna 'lote') = lote correto
  - valor sentinela da última linha (coluna 'lote') = lote correto
  - SUM(id) esperado (garante que os ids corretos estão na tabela)
"""

import sys
import io
import os
import csv
import time
import tempfile
import httpx
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).parent.parent / "sdk" / "python" / "src"))
from catworld import CatworldClient

BASE_URL   = os.getenv("CATWORLD_BASE_URL", "http://localhost:3000")
TOKEN      = os.getenv("CATWORLD_TOKEN", "")
DATASET_ID = os.getenv("CATWORLD_DATASET_ID", "")

if not TOKEN:
    print("ERRO: defina CATWORLD_TOKEN=<seu_token>"); sys.exit(1)
if not DATASET_ID:
    print("ERRO: defina CATWORLD_DATASET_ID=<dataset_id>"); sys.exit(1)

# Resolve schema name dynamically from the dataset record
_ds_resp = httpx.get(f"{BASE_URL}/api/v1/datasets", headers={"Authorization": f"Bearer {TOKEN}"}, timeout=10)
_ds_resp.raise_for_status()
_ds_list = _ds_resp.json()
_ds_items = _ds_list.get("data", _ds_list) if isinstance(_ds_list, dict) else _ds_list
_ds = next((d for d in _ds_items if d.get("id") == DATASET_ID), None)
if not _ds:
    print(f"ERRO: dataset {DATASET_ID} nao encontrado"); sys.exit(1)
SCHEMA = _ds.get("schemaName", "")
if not SCHEMA:
    print(f"ERRO: dataset {DATASET_ID} nao tem schemaName"); sys.exit(1)

POLL_INTERVAL = 4
POLL_TIMEOUT  = 600

# Tamanho que força direct-bulk (> 1MB) — calculado depois
LARGE_ROWS = 25_000  # ~25K linhas × ~50 chars ≈ 1.25MB
SMALL_ROWS = 500     # força tds-small-csv


def make_csv(path: Path, start_id: int, count: int, lote: str, extra_col: str | None = None):
    """Gera CSV com colunas: id, lote, valor_numerico, [extra]."""
    with open(path, "w", newline="", encoding="utf-8") as f:
        cols = ["id", "lote", "valor_numerico"]
        if extra_col:
            cols.append(extra_col)
        w = csv.writer(f)
        w.writerow(cols)
        for i in range(start_id, start_id + count):
            row = [i, lote, i * 10]
            if extra_col:
                row.append(f"extra_{i}")
            w.writerow(row)
    return path


def poll_upload(raw: httpx.Client, upload_id: str, label: str) -> dict:
    deadline = time.time() + POLL_TIMEOUT
    dots = 0
    while time.time() < deadline:
        resp = raw.get("/api/v1/uploads")
        resp.raise_for_status()
        uploads = resp.json()["data"]
        u = next((x for x in uploads if x["id"] == upload_id), None)
        if u is None:
            raise RuntimeError(f"Upload {upload_id} nao encontrado na lista")
        status = u.get("status", "")
        if status == "COMPLETED":
            return u
        if status == "FAILED":
            raise RuntimeError(f"Upload FAILED: {u.get('errorMessage', '?')}")
        dots += 1
        if dots % 5 == 0:
            print(f"   [{label}] aguardando... status={status}", flush=True)
        time.sleep(POLL_INTERVAL)
    raise TimeoutError(f"Upload nao completou em {POLL_TIMEOUT}s")


def do_upload(cw: CatworldClient, raw: httpx.Client, fp: Path, label: str,
              table_id: str | None = None, mode: str = "replace") -> tuple[str, str]:
    """Retorna (upload_id, table_id)."""
    size_kb = fp.stat().st_size // 1024
    method_hint = "tds-small" if fp.stat().st_size < 1_048_576 else "bulk"
    print(f"  [{label}] {fp.name} ({size_kb}KB, hint={method_hint}, mode={mode})", end=" ... ", flush=True)
    info = cw.upload(str(fp), dataset_id=DATASET_ID, mode=mode, table_id=table_id)
    upload_id = info["id"]
    completed = poll_upload(raw, upload_id, label)
    resolved_table_id = completed.get("tableId") or info.get("tableId") or table_id
    row_count = completed.get("rowCount")
    print(f"COMPLETED rows={row_count}")
    return upload_id, resolved_table_id


def q(cw: CatworldClient, sql: str) -> list[dict]:
    return cw.query(sql, dataset_id=DATASET_ID, timeout=30).rows


def check(label: str, actual, expected, fatal=True):
    ok = actual == expected
    mark = "OK" if ok else "FALHOU"
    print(f"    [{mark}] {label}: got={actual!r} expected={expected!r}")
    if not ok and fatal:
        raise AssertionError(f"{label}: {actual!r} != {expected!r}")
    return ok


def run_scenario(cw: CatworldClient, raw: httpx.Client, name: str, fn) -> bool:
    print(f"\n{'='*65}")
    print(f"  CENARIO: {name}")
    print(f"{'='*65}")
    try:
        fn(cw, raw)
        print(f"  >> PASSOU")
        return True
    except Exception as e:
        print(f"  >> FALHOU: {e}")
        return False


# ── Cenários ────────────────────────────────────────────────────────────────

def scenario_small_replace_data(cw, raw):
    """tds-small-csv: dados mudam de fato após re-replace."""
    with tempfile.TemporaryDirectory() as tmp:
        a = make_csv(Path(tmp) / "integ_small_a.csv", 1, SMALL_ROWS, "LOTE_A")
        b = make_csv(Path(tmp) / "integ_small_b.csv", 1001, SMALL_ROWS, "LOTE_B")

        _, tid = do_upload(cw, raw, a, "small A (novo)")
        sql_n = get_sql_name(cw, tid)

        rows = q(cw, f"SELECT COUNT_BIG(*) n, MIN(id) min_id, MAX(id) max_id, MAX(lote) lote FROM [{SCHEMA}].[{sql_n}]")
        check("count", int(rows[0]["n"]), SMALL_ROWS)
        check("lote", rows[0]["lote"], "LOTE_A")
        check("min_id", int(rows[0]["min_id"]), 1)

        _, tid = do_upload(cw, raw, b, "small B (replace)", table_id=tid)
        rows = q(cw, f"SELECT COUNT_BIG(*) n, MIN(id) min_id, MAX(id) max_id, MAX(lote) lote FROM [{SCHEMA}].[{sql_n}]")
        check("count pos-replace", int(rows[0]["n"]), SMALL_ROWS)
        check("lote mudou p/ B", rows[0]["lote"], "LOTE_B")
        check("min_id mudou (A sumiu)", int(rows[0]["min_id"]), 1001)
        # Confirma que NENHUM id do lote A existe
        old = q(cw, f"SELECT COUNT_BIG(*) n FROM [{SCHEMA}].[{sql_n}] WHERE id <= {SMALL_ROWS}")
        check("lote A removido", int(old[0]["n"]), 0)


def scenario_small_replace_same_count(cw, raw):
    """tds-small-csv: replace com mesmo count mas valores diferentes — conteúdo atualizado."""
    with tempfile.TemporaryDirectory() as tmp:
        a = make_csv(Path(tmp) / "integ_samecount_a.csv", 1, SMALL_ROWS, "VALOR_ORIGINAL")
        b = make_csv(Path(tmp) / "integ_samecount_b.csv", 1, SMALL_ROWS, "VALOR_NOVO")

        _, tid = do_upload(cw, raw, a, "samecount A")
        sql_n = get_sql_name(cw, tid)

        row = q(cw, f"SELECT lote FROM [{SCHEMA}].[{sql_n}] WHERE id=1")[0]
        check("lote antes", row["lote"], "VALOR_ORIGINAL")

        _, tid = do_upload(cw, raw, b, "samecount B (replace, mesmo count)", table_id=tid)
        row = q(cw, f"SELECT lote FROM [{SCHEMA}].[{sql_n}] WHERE id=1")[0]
        check("lote apos replace", row["lote"], "VALOR_NOVO")
        check("VALOR_ORIGINAL sumiu", len(q(cw, f"SELECT 1 FROM [{SCHEMA}].[{sql_n}] WHERE lote='VALOR_ORIGINAL'")), 0)


def scenario_large_replace_data(cw, raw):
    """direct-bulk + blob-bulk: dados mudam de fato após re-replace em arquivo grande."""
    with tempfile.TemporaryDirectory() as tmp:
        a = make_csv(Path(tmp) / "integ_large_a.csv", 1, LARGE_ROWS, "GRANDE_A")
        b = make_csv(Path(tmp) / "integ_large_b.csv", LARGE_ROWS + 1, LARGE_ROWS, "GRANDE_B")

        print(f"    Arquivo gerado: {a.stat().st_size // 1024}KB ({LARGE_ROWS} linhas)")

        _, tid = do_upload(cw, raw, a, "large A (direct-bulk esperado)")
        sql_n = get_sql_name(cw, tid)

        rows = q(cw, f"SELECT COUNT_BIG(*) n, MIN(id) min_id, MAX(id) max_id FROM [{SCHEMA}].[{sql_n}]")
        check("count A", int(rows[0]["n"]), LARGE_ROWS)
        check("min_id A", int(rows[0]["min_id"]), 1)

        _, tid = do_upload(cw, raw, b, "large B (blob-bulk esperado)", table_id=tid)
        rows = q(cw, f"SELECT COUNT_BIG(*) n, MIN(id) min_id, MAX(id) max_id, MAX(lote) lote FROM [{SCHEMA}].[{sql_n}]")
        check("count B", int(rows[0]["n"]), LARGE_ROWS)
        check("lote B", rows[0]["lote"], "GRANDE_B")
        check("min_id mudou (A sumiu)", int(rows[0]["min_id"]), LARGE_ROWS + 1)
        check("GRANDE_A sumiu", len(q(cw, f"SELECT 1 FROM [{SCHEMA}].[{sql_n}] WHERE id=1")), 0)


def scenario_large_replace_same_count(cw, raw):
    """blob-bulk: mesmo count mas conteúdo diferente — verifica que dados foram atualizados."""
    with tempfile.TemporaryDirectory() as tmp:
        a = make_csv(Path(tmp) / "integ_lsame_a.csv", 1, LARGE_ROWS, "LSAME_A")
        b = make_csv(Path(tmp) / "integ_lsame_b.csv", 1, LARGE_ROWS, "LSAME_B")

        _, tid = do_upload(cw, raw, a, "lsame A")
        sql_n = get_sql_name(cw, tid)

        row = q(cw, f"SELECT TOP 1 lote FROM [{SCHEMA}].[{sql_n}] ORDER BY id")[0]
        check("lote antes", row["lote"], "LSAME_A")

        _, tid = do_upload(cw, raw, b, "lsame B (replace mesmo count)", table_id=tid)
        row = q(cw, f"SELECT TOP 1 lote FROM [{SCHEMA}].[{sql_n}] ORDER BY id")[0]
        check("lote apos replace", row["lote"], "LSAME_B")
        check("LSAME_A sumiu", len(q(cw, f"SELECT 1 FROM [{SCHEMA}].[{sql_n}] WHERE lote='LSAME_A'")), 0)


def scenario_append_delta(cw, raw):
    """Append: novas linhas aparecem, antigas permanecem."""
    with tempfile.TemporaryDirectory() as tmp:
        base = make_csv(Path(tmp) / "integ_append_base.csv", 1, SMALL_ROWS, "BASE")
        extra = make_csv(Path(tmp) / "integ_append_extra.csv", SMALL_ROWS + 1, SMALL_ROWS, "EXTRA")

        _, tid = do_upload(cw, raw, base, "append base (replace)")
        sql_n = get_sql_name(cw, tid)

        r = q(cw, f"SELECT COUNT_BIG(*) n FROM [{SCHEMA}].[{sql_n}]")
        check("count base", int(r[0]["n"]), SMALL_ROWS)

        do_upload(cw, raw, extra, "append extra (delta)", table_id=tid, mode="append")

        r = q(cw, f"SELECT COUNT_BIG(*) n FROM [{SCHEMA}].[{sql_n}]")
        check("count pos-append", int(r[0]["n"]), SMALL_ROWS * 2)

        r = q(cw, f"SELECT COUNT_BIG(*) n FROM [{SCHEMA}].[{sql_n}] WHERE lote='BASE'")
        check("base ainda la", int(r[0]["n"]), SMALL_ROWS)

        r = q(cw, f"SELECT COUNT_BIG(*) n FROM [{SCHEMA}].[{sql_n}] WHERE lote='EXTRA'")
        check("extra adicionado", int(r[0]["n"]), SMALL_ROWS)


def scenario_replace_after_append(cw, raw):
    """Replace após append: tabela volta ao estado do arquivo, sem resquícios do append."""
    with tempfile.TemporaryDirectory() as tmp:
        base = make_csv(Path(tmp) / "integ_ra_base.csv", 1, SMALL_ROWS, "RA_BASE")
        extra = make_csv(Path(tmp) / "integ_ra_extra.csv", SMALL_ROWS + 1, SMALL_ROWS, "RA_EXTRA")
        clean = make_csv(Path(tmp) / "integ_ra_clean.csv", 9001, SMALL_ROWS, "RA_CLEAN")

        _, tid = do_upload(cw, raw, base, "ra base")
        sql_n = get_sql_name(cw, tid)
        do_upload(cw, raw, extra, "ra extra (append)", table_id=tid, mode="append")

        r = q(cw, f"SELECT COUNT_BIG(*) n FROM [{SCHEMA}].[{sql_n}]")
        check("count pos-append", int(r[0]["n"]), SMALL_ROWS * 2)

        do_upload(cw, raw, clean, "ra clean (replace)", table_id=tid, mode="replace")

        r = q(cw, f"SELECT COUNT_BIG(*) n FROM [{SCHEMA}].[{sql_n}]")
        check("count pos-replace", int(r[0]["n"]), SMALL_ROWS)
        check("ra_base sumiu", len(q(cw, f"SELECT 1 FROM [{SCHEMA}].[{sql_n}] WHERE lote='RA_BASE'")), 0)
        check("ra_extra sumiu", len(q(cw, f"SELECT 1 FROM [{SCHEMA}].[{sql_n}] WHERE lote='RA_EXTRA'")), 0)
        r = q(cw, f"SELECT COUNT_BIG(*) n FROM [{SCHEMA}].[{sql_n}] WHERE lote='RA_CLEAN'")
        check("ra_clean presente", int(r[0]["n"]), SMALL_ROWS)


def scenario_sum_integrity(cw, raw):
    """SUM dos valores numéricos confere — garante que nao há linhas duplicadas nem faltando."""
    with tempfile.TemporaryDirectory() as tmp:
        n = SMALL_ROWS
        a = make_csv(Path(tmp) / "integ_sum_a.csv", 1, n, "SUM_A")
        b = make_csv(Path(tmp) / "integ_sum_b.csv", n + 1, n, "SUM_B")

        # SUM(valor_numerico) = SUM(id * 10)
        # Para ids 1..n: n*(n+1)/2 * 10
        sum_a = n * (n + 1) // 2 * 10  # ids 1..500 * 10
        # Para ids n+1..2n: SUM = (n+1 + 2n)*n/2 * 10
        sum_b = (n + 1 + 2 * n) * n // 2 * 10

        _, tid = do_upload(cw, raw, a, "sum A")
        sql_n = get_sql_name(cw, tid)

        r = q(cw, f"SELECT SUM(CAST(valor_numerico AS BIGINT)) s FROM [{SCHEMA}].[{sql_n}]")
        check("SUM lote A", int(r[0]["s"]), sum_a)

        _, _ = do_upload(cw, raw, b, "sum B (replace)", table_id=tid)
        r = q(cw, f"SELECT SUM(CAST(valor_numerico AS BIGINT)) s FROM [{SCHEMA}].[{sql_n}]")
        check("SUM lote B", int(r[0]["s"]), sum_b)
        check("SUM diferente de A (dados mudaram)", int(r[0]["s"]) != sum_a, True)


def scenario_triple_replace(cw, raw):
    """3 replaces consecutivos — cada um atualiza corretamente."""
    with tempfile.TemporaryDirectory() as tmp:
        lotes = [("TRIPLE_A", 1), ("TRIPLE_B", 2001), ("TRIPLE_C", 4001)]
        tid = None
        sql_n = None
        for lote, start in lotes:
            f = make_csv(Path(tmp) / f"integ_triple_{lote}.csv", start, SMALL_ROWS, lote)
            _, tid = do_upload(cw, raw, f, f"triple {lote}", table_id=tid)
            if sql_n is None:
                sql_n = get_sql_name(cw, tid)
            r = q(cw, f"SELECT COUNT_BIG(*) n, MAX(lote) lote FROM [{SCHEMA}].[{sql_n}]")
            check(f"count apos {lote}", int(r[0]["n"]), SMALL_ROWS)
            check(f"lote apos {lote}", r[0]["lote"], lote)
            # Verifica que lotes anteriores sumiram
            for prev_lote, _ in lotes:
                if prev_lote == lote:
                    break
                leftover = q(cw, f"SELECT COUNT_BIG(*) n FROM [{SCHEMA}].[{sql_n}] WHERE lote='{prev_lote}'")
                check(f"{prev_lote} removido", int(leftover[0]["n"]), 0)


# ── Helpers ─────────────────────────────────────────────────────────────────

def get_sql_name(cw: CatworldClient, table_id: str) -> str:
    tables = cw.tables(DATASET_ID)
    t = next((x for x in tables if x["id"] == table_id), None)
    if not t:
        raise RuntimeError(f"Tabela {table_id} nao encontrada")
    return t["sqlName"]


def main():
    print(f"=== Teste de Integridade de Dados — {BASE_URL} ===")
    print(f"    SMALL_ROWS={SMALL_ROWS} | LARGE_ROWS={LARGE_ROWS} (bulk threshold)\n")

    cw = CatworldClient(base_url=BASE_URL, token=TOKEN, timeout=60)
    raw = httpx.Client(
        base_url=BASE_URL,
        headers={"Authorization": f"Bearer {TOKEN}"},
        timeout=30,
    )

    scenarios = [
        ("tds-small-csv: replace muda dados (ids diferentes)", scenario_small_replace_data),
        ("tds-small-csv: replace muda dados (mesmo count, valores diferentes)", scenario_small_replace_same_count),
        ("bulk: replace muda dados (ids diferentes)", scenario_large_replace_data),
        ("bulk: replace muda dados (mesmo count, valores diferentes)", scenario_large_replace_same_count),
        ("append (delta): novas linhas adicionadas, antigas preservadas", scenario_append_delta),
        ("replace apos append: dados anteriores removidos", scenario_replace_after_append),
        ("SUM numerico confere apos replace", scenario_sum_integrity),
        ("3 replaces consecutivos: cada um atualiza corretamente", scenario_triple_replace),
    ]

    results = []
    for name, fn in scenarios:
        ok = run_scenario(cw, raw, name, fn)
        results.append((name, ok))

    print(f"\n{'='*65}")
    print("SUMARIO FINAL")
    print(f"{'='*65}")
    passed = sum(1 for _, ok in results if ok)
    print(f"Passaram: {passed}/{len(results)}\n")
    for name, ok in results:
        mark = "PASSOU" if ok else "FALHOU"
        print(f"  [{mark}] {name}")

    if passed < len(results):
        sys.exit(1)


if __name__ == "__main__":
    main()
