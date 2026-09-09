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
        if request.method == "POST" and request.url.path == "/api/v1/uploads/upload-123" and request.url.params.get("action") == "uploaded":
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
            client.upload(upload_file, dataset_id="dataset-1", wait=True, poll_interval=0)
    finally:
        client.close()
        upload_file.unlink(missing_ok=True)


def test_upload_wait_raises_upload_error_on_failed_status():
    from catworld import UploadError

    upload_file = Path("sdk/python/tests/.tmp-upload-fail.csv")
    upload_file.write_text("id,name\n1,Mochi\n", encoding="utf-8")

    statuses = iter(["IMPORTING", "FAILED"])

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and request.url.path == "/api/v1/uploads":
            return httpx.Response(200, json={"data": {
                "upload": {"id": "upload-fail"},
                "sas": {"url": "https://blob.example/upload-fail"},
            }})
        if request.method == "PUT" and request.url.host == "blob.example":
            return httpx.Response(201, text="")
        if request.method == "POST" and request.url.path == "/api/v1/uploads/upload-fail" and request.url.params.get("action") == "uploaded":
            return httpx.Response(200, json={"data": {"ok": True}})
        if request.method == "GET" and request.url.path == "/api/v1/uploads/upload-fail":
            status = next(statuses)
            body = {"status": status}
            if status == "FAILED":
                body["errorMessage"] = "Schema incompatível. Esperado: a, b; atual: a, b, c"
            return httpx.Response(200, json={"data": body})
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    client = CatworldClient("https://catworld.example", "cw_live_test")
    client._client.close()
    client._client = httpx.Client(base_url="https://catworld.example", transport=httpx.MockTransport(handler))

    try:
        with pytest.raises(UploadError, match="Schema incompatível"):
            client.upload(upload_file, dataset_id="dataset-1", wait=True, poll_interval=0)
    finally:
        client.close()
        upload_file.unlink(missing_ok=True)


def test_upload_wait_returns_final_upload_on_completed():
    upload_file = Path("sdk/python/tests/.tmp-upload-ok.csv")
    upload_file.write_text("id,name\n1,Mochi\n", encoding="utf-8")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and request.url.path == "/api/v1/uploads":
            return httpx.Response(200, json={"data": {
                "upload": {"id": "upload-ok"},
                "sas": {"url": "https://blob.example/upload-ok"},
            }})
        if request.method == "PUT" and request.url.host == "blob.example":
            return httpx.Response(201, text="")
        if request.method == "POST" and request.url.path == "/api/v1/uploads/upload-ok" and request.url.params.get("action") == "uploaded":
            return httpx.Response(200, json={"data": {"ok": True}})
        if request.method == "GET" and request.url.path == "/api/v1/uploads/upload-ok":
            return httpx.Response(200, json={"data": {"status": "COMPLETED", "rowCount": 42}})
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    client = CatworldClient("https://catworld.example", "cw_live_test")
    client._client.close()
    client._client = httpx.Client(base_url="https://catworld.example", transport=httpx.MockTransport(handler))

    try:
        result = client.upload(upload_file, dataset_id="dataset-1", wait=True, poll_interval=0)
        assert result == {"status": "COMPLETED", "rowCount": 42}
    finally:
        client.close()
        upload_file.unlink(missing_ok=True)


def test_upload_wait_false_returns_immediately_without_polling():
    upload_file = Path("sdk/python/tests/.tmp-upload-nowait.csv")
    upload_file.write_text("id,name\n1,Mochi\n", encoding="utf-8")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and request.url.path == "/api/v1/uploads":
            return httpx.Response(200, json={"data": {
                "upload": {"id": "upload-nowait", "status": "PENDING_UPLOAD"},
                "sas": {"url": "https://blob.example/upload-nowait"},
            }})
        if request.method == "PUT" and request.url.host == "blob.example":
            return httpx.Response(201, text="")
        if request.method == "POST" and request.url.path == "/api/v1/uploads/upload-nowait" and request.url.params.get("action") == "uploaded":
            return httpx.Response(200, json={"data": {"ok": True}})
        raise AssertionError(f"Unexpected request (should not poll with wait=False): {request.method} {request.url}")

    client = CatworldClient("https://catworld.example", "cw_live_test")
    client._client.close()
    client._client = httpx.Client(base_url="https://catworld.example", transport=httpx.MockTransport(handler))

    try:
        result = client.upload(upload_file, dataset_id="dataset-1", wait=False)
        assert result == {"id": "upload-nowait", "status": "PENDING_UPLOAD"}
    finally:
        client.close()
        upload_file.unlink(missing_ok=True)


def test_check_append_compat_raises_on_mismatch():
    from catworld import ValidationError

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/datasets/ds_1/tables"
        return httpx.Response(200, json={"data": [
            {"id": "tbl_1", "columns": [
                {"sqlName": "periodo_inicio"}, {"sqlName": "periodo_fim"}, {"sqlName": "relatorio"},
            ]},
        ]})

    with client_with_handler(handler) as client:
        with pytest.raises(ValidationError, match="Schema incompatível"):
            client.check_append_compat("ds_1", "tbl_1", ["Cta Pk", "Período Início", "Período Fim", "Relatório"])


def test_check_append_compat_passes_on_match_with_normalized_headers():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/datasets/ds_1/tables"
        return httpx.Response(200, json={"data": [
            {"id": "tbl_1", "columns": [
                {"sqlName": "periodo_inicio"}, {"sqlName": "periodo_fim"}, {"sqlName": "relatorio"},
            ]},
        ]})

    with client_with_handler(handler) as client:
        client.check_append_compat("ds_1", "tbl_1", ["Período Início", "Período Fim", "Relatório"])  # não deve levantar


def test_check_append_compat_ignores_internal_rh_column():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/datasets/ds_1/tables"
        return httpx.Response(200, json={"data": [
            {"id": "tbl_1", "columns": [
                {"sqlName": "a"}, {"sqlName": "b"}, {"sqlName": "_cw_rh"},
            ]},
        ]})

    with client_with_handler(handler) as client:
        client.check_append_compat("ds_1", "tbl_1", ["a", "b"])  # não deve levantar (_cw_rh é interno)


def test_check_append_compat_skips_unknown_table_silently():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/datasets/ds_1/tables"
        return httpx.Response(200, json={"data": []})

    with client_with_handler(handler) as client:
        client.check_append_compat("ds_1", "tbl_novo", ["a", "b"])  # tabela nova — sem erro
