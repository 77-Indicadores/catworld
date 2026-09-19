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


def page(rows, **meta):
    base = {"columns": ["id"], "rowCount": len(rows), "removedKeys": [], "nextSince": "2026-09-19T10:00:00.000Z", "hasMore": False}
    base.update(meta)
    return httpx.Response(200, json={"data": rows, "meta": base, "error": None})


def test_changes_follows_cursor_until_exhausted_and_merges_everything():
    calls = []

    def handler(request):
        q = {k: v[0] for k, v in parse_qs(urlparse(str(request.url)).query).items()}
        calls.append(q)
        if "cursor" not in q:
            return page([{"id": 1}, {"id": 2}], hasMore=True, nextCursor="C1", removedKeys=[90])
        if q["cursor"] == "C1":
            return page([{"id": 3}, {"id": 4}], hasMore=True, nextCursor="C2", removedKeys=[])
        return page([{"id": 5}], hasMore=False, nextSince="2026-09-19T12:00:00.000Z")

    with client_with_handler(handler) as client:
        out = client.changes("tbl", since="2026-01-01T00:00:00Z", limit=2)

    assert [r["id"] for r in out["rows"]] == [1, 2, 3, 4, 5]
    assert out["removedKeys"] == [90]
    assert out["nextSince"] == "2026-09-19T12:00:00.000Z"
    # o cursor sempre acompanha o `since` original
    assert calls[1]["since"] == "2026-01-01T00:00:00Z" and calls[1]["cursor"] == "C1"
    assert calls[2]["cursor"] == "C2"


def test_changes_without_cursor_follows_next_since_when_server_says_has_more():
    calls = []

    def handler(request):
        q = {k: v[0] for k, v in parse_qs(urlparse(str(request.url)).query).items()}
        calls.append(q)
        if q["since"] == "2026-01-01T00:00:00Z":
            return page([{"id": 1}], hasMore=True, nextSince="2026-09-19T10:00:00.000Z")
        return page([{"id": 2}], hasMore=False, nextSince="2026-09-19T11:00:00.000Z")

    with client_with_handler(handler) as client:
        out = client.changes("tbl", since="2026-01-01T00:00:00Z")
    assert [r["id"] for r in out["rows"]] == [1, 2]
    assert out["nextSince"] == "2026-09-19T11:00:00.000Z"
    assert len(calls) == 2


def test_changes_follow_false_makes_a_single_call():
    calls = []

    def handler(request):
        calls.append(1)
        return page([{"id": 1}], hasMore=True, nextCursor="C1")

    with client_with_handler(handler) as client:
        out = client.changes("tbl", since="2026-01-01T00:00:00Z", follow=False)
    assert len(calls) == 1
    assert out["rows"] == [{"id": 1}]


def test_changes_does_not_loop_forever_without_progress():
    calls = []

    def handler(request):
        calls.append(1)
        # servidor antigo/estranho: diz que ha mais, mas nao da cursor nem avanca o nextSince
        return page([{"id": 1}], hasMore=True, nextSince="2026-01-01T00:00:00Z")

    with client_with_handler(handler) as client:
        out = client.changes("tbl", since="2026-01-01T00:00:00Z")
    assert len(calls) == 1 and out["rows"] == [{"id": 1}]


def test_changes_baseline_and_servers_without_has_more_are_unchanged():
    calls = []

    def handler(request):
        calls.append(str(request.url))
        body = {"data": [{"id": 1}], "meta": {"columns": ["id"], "rowCount": 1, "nextSince": "2026-09-19T10:00:00.000Z"}, "error": None}
        return httpx.Response(200, json=body)

    with client_with_handler(handler) as client:
        out = client.changes("tbl")  # baseline: sem since
    assert len(calls) == 1 and "since" not in calls[0]
    assert out == {"rows": [{"id": 1}], "removedKeys": None, "nextSince": "2026-09-19T10:00:00.000Z"}
