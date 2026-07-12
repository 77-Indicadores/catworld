from catworld import CatworldClient
import httpx
import json
import pytest
from pathlib import Path

from catworld import ConnectionError


def test_client_constructs():
    client = CatworldClient("https://catworld.example", "cw_live_test")
    assert client is not None
    client.close()


def test_client_context_manager():
    with CatworldClient("https://catworld.example", "cw_live_test") as client:
        assert client is not None


def client_with_handler(handler):
    client = CatworldClient("https://catworld.example", "cw_live_test")
    client._client = httpx.Client(
        base_url="https://catworld.example",
        headers={"Authorization": "Bearer cw_live_test"},
        transport=httpx.MockTransport(handler),
    )
    return client


def test_sources_endpoint():
    def handler(request):
        assert request.method == "GET"
        assert request.url.path == "/api/v1/datasets/ds_1/sources"
        return httpx.Response(200, json={"data": [{"id": "src_1"}]})

    with client_with_handler(handler) as client:
        assert client.sources("ds_1") == [{"id": "src_1"}]


def test_refresh_source_endpoint():
    def handler(request):
        assert request.method == "POST"
        assert request.url.path == "/api/v1/dataset-sources/src_1/refresh"
        return httpx.Response(200, json={"data": {"queued": True}})

    with client_with_handler(handler) as client:
        assert client.refresh_source("src_1") == {"queued": True}


def test_live_query_endpoint():
    def handler(request):
        assert request.method == "POST"
        assert request.url.path == "/api/v1/dataset-sources/src_1/query"
        assert json.loads(request.content) == {"timeout": 30, "limit": 100, "sql": "SELECT * FROM clientes"}
        return httpx.Response(200, json={"data": {"rows": []}})

    with client_with_handler(handler) as client:
        result = client.live_query("src_1", "SELECT * FROM clientes", limit=100)
        assert result == {"rows": []}
        assert result.rows == []


def test_query_routes_live_table_through_live_endpoint():
    calls = []

    def handler(request):
        calls.append((request.method, request.url.path, json.loads(request.content) if request.content else None))
        if request.url.path == "/api/v1/datasets/ds_1/tables":
            return httpx.Response(200, json={"data": [
                {"id": "tbl_1", "name": "clientes", "sqlName": "clientes", "source": {"id": "src_1", "mode": "live", "sourceTable": "clientes"}}
            ]})
        assert request.url.path == "/api/v1/dataset-sources/src_1/query"
        return httpx.Response(200, json={"data": {"rows": [{"id": 1}]}})

    with client_with_handler(handler) as client:
        result = client.query("SELECT * FROM clientes", dataset_id="ds_1", limit=50)
        assert result == {"rows": [{"id": 1}]}
        assert result.rows == [{"id": 1}]

    assert calls[0][:2] == ("GET", "/api/v1/datasets/ds_1/tables")
    assert calls[1] == ("POST", "/api/v1/dataset-sources/src_1/query", {"timeout": 30, "limit": 50, "sql": "SELECT * FROM clientes"})


def test_query_result_exposes_dataframe_property():
    pandas = pytest.importorskip("pandas")

    def handler(request):
        if request.url.path == "/api/v1/datasets/ds_1/tables":
            return httpx.Response(200, json={"data": [
                {"id": "tbl_1", "name": "clientes", "sqlName": "clientes", "source": None}
            ]})
        return httpx.Response(200, json={"data": {"columns": ["id", "nome"], "rows": [{"id": 1, "nome": "Ana"}]}})

    with client_with_handler(handler) as client:
        result = client.query("SELECT * FROM clientes", dataset_id="ds_1")
        assert result.columns == ["id", "nome"]
        assert isinstance(result.dataframe, pandas.DataFrame)
        assert result.dataframe.to_dict("records") == [{"id": 1, "nome": "Ana"}]


def test_query_keeps_internal_tables_on_query_endpoint():
    def handler(request):
        if request.url.path == "/api/v1/datasets/ds_1/tables":
            return httpx.Response(200, json={"data": [
                {"id": "tbl_1", "name": "clientes", "sqlName": "clientes", "source": None}
            ]})
        assert request.method == "POST"
        assert request.url.path == "/api/v1/queries"
        assert json.loads(request.content)["datasetId"] == "ds_1"
        return httpx.Response(200, json={"data": {"rows": []}})

    with client_with_handler(handler) as client:
        assert client.query("SELECT * FROM clientes", dataset_id="ds_1") == {"rows": []}


def test_query_rejects_mixed_live_and_internal_tables():
    def handler(request):
        assert request.url.path == "/api/v1/datasets/ds_1/tables"
        return httpx.Response(200, json={"data": [
            {"id": "tbl_1", "name": "clientes", "sqlName": "clientes", "source": {"id": "src_1", "mode": "live", "sourceTable": "clientes"}},
            {"id": "tbl_2", "name": "pedidos", "sqlName": "pedidos", "source": None},
        ]})

    with client_with_handler(handler) as client:
        try:
            client.query("SELECT * FROM clientes JOIN pedidos ON pedidos.cliente_id = clientes.id", dataset_id="ds_1")
        except Exception as exc:
            assert exc.code == "MIXED_QUERY_ENGINES"
        else:
            raise AssertionError("Expected mixed engine validation error")


def test_upload_raises_connection_error_when_polling_gets_non_json_error():
    upload_file = Path("sdk/python/tests/.tmp-upload.csv")
    upload_file.write_text("id,name\n1,Mochi\n", encoding="utf-8")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and request.url.path == "/api/v1/uploads":
            return httpx.Response(
                200,
                json={
                    "data": {
                        "upload": {"id": "upload-123"},
                        "sas": {"url": "https://blob.example/upload-123"},
                    }
                },
            )
        if request.method == "PUT" and request.url.host == "blob.example":
            return httpx.Response(201, text="")
        if request.method == "POST" and request.url.path == "/api/v1/uploads/upload-123/uploaded":
            return httpx.Response(200, json={"data": {"ok": True}})
        if request.method == "GET" and request.url.path == "/api/v1/uploads/upload-123":
            return httpx.Response(502, text="Bad Gateway")
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    client = CatworldClient("https://catworld.example", "cw_live_test")
    client._client.close()
    client._client = httpx.Client(
        base_url="https://catworld.example",
        transport=httpx.MockTransport(handler),
    )

    try:
        with pytest.raises(ConnectionError, match="Bad Gateway"):
            client.upload(upload_file, dataset_id="dataset-1", poll_interval=0)
    finally:
        client.close()
        upload_file.unlink(missing_ok=True)
