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
    assert calls[1] == ("POST", "/api/v1/dataset-sources/src_1/query", {"timeout": 60, "limit": 50, "sql": "SELECT * FROM clientes"})


def test_query_result_exposes_dataframe_property():
    pandas = pytest.importorskip("pandas")

    def handler(request):
        if request.url.path == "/api/v1/datasets/ds_1/tables":
            return httpx.Response(200, json={"data": [
                {"id": "tbl_1", "name": "clientes", "sqlName": "clientes", "source": None}
            ]})
        return httpx.Response(200, json={"data": {"columns": ["id", "nome"], "rows": [{"id": 1, "nome": "Ana"}]}})

    with client_with_handler(handler) as client:
        result = client.query("SELECT * FROM clientes", dataset_id="ds_1", limit=100)
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
        assert client.query("SELECT * FROM clientes", dataset_id="ds_1", limit=100) == {"rows": []}


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
    upload_file = Path(__file__).parent / ".tmp-upload.csv"
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

    upload_file = Path(__file__).parent / ".tmp-upload-fail.csv"
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
    upload_file = Path(__file__).parent / ".tmp-upload-ok.csv"
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
    upload_file = Path(__file__).parent / ".tmp-upload-nowait.csv"
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


def test_check_upsert_ready_raises_on_unknown_key_column():
    from catworld import ValidationError

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/datasets/ds_1/tables"
        return httpx.Response(200, json={"data": [
            {"id": "tbl_1", "sqlName": "clientes", "columns": [{"sqlName": "id"}, {"sqlName": "nome"}]},
        ]})

    with client_with_handler(handler) as client:
        with pytest.raises(ValidationError, match="não existe na tabela"):
            client.check_upsert_ready("ds_1", "tbl_1", "documento")


def test_check_upsert_ready_raises_when_key_already_duplicated_in_target():
    from catworld import ValidationError

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/datasets/ds_1/tables":
            return httpx.Response(200, json={"data": [
                {"id": "tbl_1", "sqlName": "clientes", "columns": [{"sqlName": "id"}, {"sqlName": "documento"}]},
            ]})
        assert request.method == "POST" and request.url.path == "/api/v1/queries"
        return httpx.Response(200, json={"data": {"rows": [{"k": "123", "n": 2}], "columns": ["k", "n"], "rowCount": 1}})

    with client_with_handler(handler) as client:
        with pytest.raises(ValidationError, match="já não é única"):
            client.check_upsert_ready("ds_1", "tbl_1", "documento")


def test_check_upsert_ready_passes_when_key_is_unique():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/datasets/ds_1/tables":
            return httpx.Response(200, json={"data": [
                {"id": "tbl_1", "sqlName": "clientes", "columns": [{"sqlName": "id"}, {"sqlName": "documento"}]},
            ]})
        assert request.method == "POST" and request.url.path == "/api/v1/queries"
        return httpx.Response(200, json={"data": {"rows": [], "columns": [], "rowCount": 0}})

    with client_with_handler(handler) as client:
        client.check_upsert_ready("ds_1", "tbl_1", "documento")  # não deve levantar


def test_check_upsert_ready_skips_unknown_table_silently():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/datasets/ds_1/tables"
        return httpx.Response(200, json={"data": []})

    with client_with_handler(handler) as client:
        client.check_upsert_ready("ds_1", "tbl_novo", "documento")  # tabela nova — sem erro


def test_upload_raises_immediately_for_upsert_without_key_column():
    from catworld import ValidationError

    upload_file = Path(__file__).parent / ".tmp-upload-no-key.csv"
    upload_file.write_text("id,name\n1,Mochi\n", encoding="utf-8")

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"Nenhuma requisição deveria ser feita, mas recebi: {request.method} {request.url}")

    client = CatworldClient("https://catworld.example", "cw_live_test")
    client._client.close()
    client._client = httpx.Client(base_url="https://catworld.example", transport=httpx.MockTransport(handler))

    try:
        with pytest.raises(ValidationError, match="key_column"):
            client.upload(upload_file, dataset_id="dataset-1", mode="upsert")
    finally:
        client.close()
        upload_file.unlink(missing_ok=True)


def test_upload_runs_preflight_and_blocks_before_sending_bytes():
    from catworld import ValidationError

    upload_file = Path(__file__).parent / ".tmp-upload-preflight.csv"
    upload_file.write_text("id,documento\n1,999\n", encoding="utf-8")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/datasets/ds_1/tables":
            return httpx.Response(200, json={"data": [
                {"id": "tbl_1", "sqlName": "clientes", "columns": [{"sqlName": "outra_coisa"}]},
            ]})
        raise AssertionError(f"Upload não deveria prosseguir após falha de preflight: {request.method} {request.url}")

    client = CatworldClient("https://catworld.example", "cw_live_test")
    client._client.close()
    client._client = httpx.Client(base_url="https://catworld.example", transport=httpx.MockTransport(handler))

    try:
        with pytest.raises(ValidationError, match="Schema incompatível"):
            client.upload(upload_file, dataset_id="ds_1", table_id="tbl_1", mode="append")
    finally:
        client.close()
        upload_file.unlink(missing_ok=True)


def test_upload_sends_type_overrides_in_create_body():
    upload_file = Path(__file__).parent / ".tmp-upload-overrides.csv"
    upload_file.write_text("id,dt\n1,2026-01-01\n", encoding="utf-8")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and request.url.path == "/api/v1/uploads":
            body = json.loads(request.content)
            assert body["typeOverrides"] == {"dt": "DATE"}
            return httpx.Response(200, json={"data": {
                "upload": {"id": "upload-ov", "status": "PENDING_UPLOAD"},
                "sas": {"url": "https://blob.example/upload-ov"},
            }})
        if request.method == "PUT" and request.url.host == "blob.example":
            return httpx.Response(201, text="")
        if request.method == "POST" and request.url.params.get("action") == "uploaded":
            return httpx.Response(200, json={"data": {"ok": True}})
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    client = CatworldClient("https://catworld.example", "cw_live_test")
    client._client.close()
    client._client = httpx.Client(base_url="https://catworld.example", transport=httpx.MockTransport(handler))

    try:
        client.upload(upload_file, dataset_id="dataset-1", column_types={"dt": "DATE"}, wait=False)
    finally:
        client.close()
        upload_file.unlink(missing_ok=True)


def test_query_payload_only_carries_normalize_when_requested():
    """Compatibilidade: sem normalize o corpo enviado e identico ao de antes do contrato de SQL."""
    bodies = []

    def handler(request):
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json={"data": {"rows": [], "columns": [], "rowCount": 0}})

    with client_with_handler(handler) as client:
        client.query("SELECT 1", limit=10)
        client.query("SELECT 1", limit=10, normalize=True)

    assert "normalize" not in bodies[0]
    assert bodies[1]["normalize"] is True
    assert bodies[0] == {"sql": "SELECT 1", "timeout": 60, "limit": 10, "offset": 0}


def test_server_warnings_become_python_runtime_warnings():
    """meta.warnings do servidor (ex: paginacao sem ORDER BY) chegam ao usuario do SDK sem bloquear a chamada."""
    def handler(request):
        return httpx.Response(200, json={
            "data": {"rows": [{"a": 1}], "columns": ["a"], "rowCount": 1},
            "meta": {"warnings": ["paginacao com offset sem ORDER BY"]},
            "error": None,
        })

    with client_with_handler(handler) as client:
        with pytest.warns(RuntimeWarning, match="paginacao com offset sem ORDER BY"):
            result = client.query("SELECT 1", limit=10)
    assert result.rows == [{"a": 1}]
