import json

import httpx
import pytest

from catworld import CatworldClient, ConnectionError


def _client(body: str) -> CatworldClient:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=body.encode(), headers={"content-type": "application/x-ndjson"})

    c = CatworldClient("https://catworld.example", "tok")
    c._client = httpx.Client(base_url="https://catworld.example", transport=httpx.MockTransport(handler))
    c._resolve_live_source_for_query = lambda *a, **k: None  # type: ignore[method-assign]
    return c


def _nd(*objs) -> str:
    return "\n".join(json.dumps(o) for o in objs) + "\n"


def test_stream_ok():
    c = _client(_nd({"__columns__": ["a"]}, {"a": 1}, {"a": 2}, {"__done__": True, "rowCount": 2, "executionTimeMs": 5}))
    r = c.query("SELECT a FROM t")
    assert r["rowCount"] == 2 and [x["a"] for x in r.rows] == [1, 2]


def test_stream_without_done_is_an_error():
    c = _client(_nd({"__columns__": ["a"]}, {"a": 1}))
    with pytest.raises(ConnectionError, match="__done__"):
        c.query("SELECT a FROM t")


def test_stream_rowcount_mismatch_is_an_error():
    c = _client(_nd({"__columns__": ["a"]}, {"a": 1}, {"__done__": True, "rowCount": 2}))
    with pytest.raises(ConnectionError, match="incompleto"):
        c.query("SELECT a FROM t")


def test_stream_malformed_line_is_not_skipped():
    body = '{"__columns__": ["a"]}\n{"a": 1}\n{"a": \n{"__done__": true, "rowCount": 1}\n'
    c = _client(body)
    with pytest.raises(ConnectionError, match="corrompido"):
        c.query("SELECT a FROM t")


def test_iter_query_streams_in_batches_and_validates():
    rows = [{"a": i} for i in range(25_000)]
    c = _client(_nd({"__columns__": ["a"]}, *rows, {"__done__": True, "rowCount": 25_000}))
    sizes = [len(p.rows) for p in c.iter_query("SELECT a FROM t")]
    assert sizes == [10_000, 10_000, 5_000]


def test_iter_query_truncated_flag_drives_paging():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        calls.append(payload["offset"])
        off = payload["offset"]
        if off == 0:
            return httpx.Response(200, json={"data": {"rows": [{"a": 1}] * 3, "columns": ["a"], "rowCount": 3, "truncated": True}})
        return httpx.Response(200, json={"data": {"rows": [{"a": 2}] * 2, "columns": ["a"], "rowCount": 2, "truncated": False}})

    c = CatworldClient("https://catworld.example", "tok")
    c._client = httpx.Client(base_url="https://catworld.example", transport=httpx.MockTransport(handler))
    c._resolve_live_source_for_query = lambda *a, **k: None  # type: ignore[method-assign]
    pages = list(c.iter_query("SELECT a FROM t", stream=False))
    assert calls == [0, 3] and len(pages) == 2
