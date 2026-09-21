import datetime
import json
from urllib.parse import parse_qs, urlparse

import httpx

from catworld import CatworldClient


def client_with_handler(handler):
    client = CatworldClient("https://catworld.example", "cw_live_test")
    client._client = httpx.Client(
        base_url="https://catworld.example",
        headers={"Authorization": "Bearer cw_live_test"},
        transport=httpx.MockTransport(handler),
    )
    return client


def page(rows, stamps=None, **meta):
    base = {"columns": ["id"], "rowCount": len(rows), "removedKeys": [], "nextSince": "2026-09-19T10:00:00.000000Z", "hasMore": False}
    if stamps is not None:
        base["rowStamps"] = stamps
    base.update(meta)
    return httpx.Response(200, json={"data": rows, "meta": base, "error": None})


def test_baseline_without_since_follows_cursor_and_requests_stamps():
    calls = []

    def handler(request):
        q = {k: v[0] for k, v in parse_qs(urlparse(str(request.url)).query).items()}
        calls.append(q)
        if "cursor" not in q:
            return page([{"id": 1}, {"id": 2}], hasMore=True, nextCursor="C1", nextSince="2026-09-19T09:00:00.000000Z")
        return page([{"id": 3}], hasMore=False, nextSince="2026-09-19T10:00:00.000000Z")

    with client_with_handler(handler) as client:
        out = client.changes("tbl", limit=2)  # sem since: baseline
    assert [r["id"] for r in out["rows"]] == [1, 2, 3]
    assert out["hasMore"] is False
    assert out["nextSince"] == "2026-09-19T10:00:00.000000Z"
    assert "since" not in calls[0] and calls[0]["stamps"] == "1"
    assert calls[1]["cursor"] == "C1" and "since" not in calls[1]


def test_datetime_since_is_sent_as_utc_with_microseconds_never_local_time():
    seen = {}

    def handler(request):
        seen.update({k: v[0] for k, v in parse_qs(urlparse(str(request.url)).query).items()})
        return page([])

    with client_with_handler(handler) as client:
        client.changes("tbl", since=datetime.datetime(2026, 9, 19, 10, 0, 0, 123456))
        assert seen["since"] == "2026-09-19T10:00:00.123456Z"
        tz = datetime.timezone(datetime.timedelta(hours=-3))
        client.changes("tbl", since=datetime.datetime(2026, 9, 19, 10, 0, 0, tzinfo=tz))
        assert seen["since"] == "2026-09-19T13:00:00.000000Z"


def test_rows_inside_the_safety_window_are_deduplicated_across_calls():
    stamp = "2026-09-19T10:04:00.000000Z"
    rows = [{"id": 1}, {"id": 2}]

    def handler(request):
        return page(rows, stamps=[stamp, stamp], nextSince="2026-09-19T10:00:00.000000Z")  # nextSince recuou (janela)

    with client_with_handler(handler) as client:
        first = client.changes("tbl", since="2026-09-19T09:00:00Z")
        assert [r["id"] for r in first["rows"]] == [1, 2]
        assert len(first["seen"]) == 2  # carimbo >= nextSince: pode voltar
        second = client.changes("tbl", since=first["nextSince"], seen=first["seen"])
        assert second["rows"] == []  # mesmas linhas de novo: descartadas
        # a linha mudou de conteudo (mesmo carimbo): nao e a mesma impressao digital
        rows[0] = {"id": 1, "x": "novo"}
        third = client.changes("tbl", since=first["nextSince"], seen=second["seen"])
        assert third["rows"] == [{"id": 1, "x": "novo"}]


def test_seen_is_pruned_once_nextsince_passes_the_stamp():
    def handler(request):
        return page([{"id": 1}], stamps=["2026-09-19T09:00:00.000000Z"], nextSince="2026-09-19T10:00:00.000000Z")

    with client_with_handler(handler) as client:
        out = client.changes("tbl", since="2026-09-19T08:00:00Z")
        assert out["seen"] == []  # carimbo < nextSince: nunca mais volta


STAMP = "2026-09-19T10:00:00.000000Z"


def test_identical_rows_sharing_a_stamp_are_all_delivered_and_deduped_by_multiplicity():
    """Tabela sem chave: 2 linhas IDENTICAS + 1 diferente no mesmo carimbo entregam 3; na volta (janela) entregam 0; uma 3a identica nova entrega 1."""
    rows = [{"id": 1}, {"id": 1}, {"id": 2}]

    def handler(request):
        return page(rows, stamps=[STAMP] * len(rows), nextSince="2026-09-19T09:00:00.000000Z")

    with client_with_handler(handler) as client:
        first = client.changes("tbl")
        assert [r["id"] for r in first["rows"]] == [1, 1, 2]
        second = client.changes("tbl", since=first["nextSince"], seen=first["seen"])
        assert second["rows"] == []


def test_third_identical_row_is_delivered_once():
    state = {"rows": [{"id": 1}, {"id": 1}]}

    def handler(request):
        r = state["rows"]
        return page(r, stamps=[STAMP] * len(r), nextSince="2026-09-19T09:00:00.000000Z")

    with client_with_handler(handler) as client:
        first = client.changes("tbl")
        assert len(first["rows"]) == 2
        state["rows"] = [{"id": 1}, {"id": 1}, {"id": 1}]
        second = client.changes("tbl", since=first["nextSince"], seen=first["seen"])
        assert len(second["rows"]) == 1


def test_seen_is_capped_and_falls_back_to_stamp_counts():
    n = 50
    rows = [{"id": i} for i in range(n)]

    def handler(request):
        return page(rows, stamps=[STAMP] * n, nextSince="2026-09-19T09:00:00.000000Z")

    with client_with_handler(handler) as client:
        first = client.changes("tbl", seen_limit=10)
        assert len(first["rows"]) == n
        assert len(first["seen"]) <= 10  # compacto: um contador por carimbo
        second = client.changes("tbl", since=first["nextSince"], seen=first["seen"], seen_limit=10)
        assert second["rows"] == []  # continua sem repetir
