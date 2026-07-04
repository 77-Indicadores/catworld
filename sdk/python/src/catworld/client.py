from __future__ import annotations

import json as _json
import logging
import time
from pathlib import Path
from typing import Any

import httpx

from .exceptions import (
    ConnectionError,
    QueryTimeoutError,
    UploadError,
    ValidationError,
    from_api_error,
)

logger = logging.getLogger("catworld")
logger.addHandler(logging.NullHandler())


def _fmt_bytes(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


class CatworldClient:
    def __init__(self, base_url: str, token: str, timeout: float = 30):
        self._client = httpx.Client(
            base_url=base_url.rstrip("/"),
            headers={"Authorization": f"Bearer {token}"},
            timeout=timeout,
        )
        logger.debug("Conectado a %s", base_url)

    def close(self):
        self._client.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def projects(self):
        return self._request("GET", "/api/v1/projects")

    def datasets(self):
        return self._request("GET", "/api/v1/datasets")

    def tables(self, dataset_id: str):
        return self._request("GET", f"/api/v1/datasets/{dataset_id}/tables")

    def rows(self, table_id: str, limit: int = 100):
        return self._request("GET", f"/api/v1/tables/{table_id}/rows", params={"limit": limit})

    def query(
        self,
        sql: str,
        timeout: int = 30,
        limit: int = 10000,
        dataset_id: str | None = None,
        project_id: str | None = None,
    ):
        context = f"dataset={dataset_id}" if dataset_id else f"project={project_id}" if project_id else "sem contexto"
        logger.info("Executando query [%s, timeout=%ss, limit=%s]", context, timeout, limit)

        payload: dict = {"sql": sql, "timeout": timeout, "limit": limit}
        if dataset_id:
            payload["datasetId"] = dataset_id
        if project_id:
            payload["projectId"] = project_id

        result = self._request("POST", "/api/v1/queries", json=payload, timeout=None)
        logger.info(
            "Query concluída: %s linha(s) em %sms",
            result.get("rowCount", "?"),
            result.get("executionTimeMs", "?"),
        )
        return result

    def upload(
        self,
        path: str | Path,
        dataset_id: str,
        mode: str = "replace",
        key_column: str | None = None,
        poll_interval: float = 2,
    ):
        file = Path(path)
        if not file.exists():
            raise FileNotFoundError(f"Arquivo não encontrado: {file}")
        size = file.stat().st_size

        logger.info(
            "Iniciando upload: %s (%s) → dataset=%s [modo=%s]",
            file.name, _fmt_bytes(size), dataset_id, mode,
        )

        created = self._request(
            "POST",
            "/api/v1/uploads",
            json={"filename": file.name, "sizeBytes": size},
        )
        upload_id = created["upload"]["id"]

        logger.info("Enviando arquivo para storage...")
        for attempt in range(3):
            with file.open("rb") as stream:
                response = self._client.put(
                    created["sas"]["url"],
                    content=stream,
                    headers={"content-type": "application/octet-stream"},
                    timeout=None,
                )
            if response.status_code != 499 or attempt == 2:
                response.raise_for_status()
                break
            logger.warning("Conexão encerrada pelo servidor (499), tentativa %s/3...", attempt + 1)
            time.sleep(1)
        logger.info("Arquivo enviado, aguardando processamento...")

        self._request("POST", f"/api/v1/uploads/{upload_id}/uploaded")
        preview = self._wait_upload(upload_id, "AWAITING_CONFIRMATION", poll_interval)

        mapping = preview["previewJson"]
        if isinstance(mapping, str):
            mapping = _json.loads(mapping)

        cols = mapping.get("columns", [])
        if not cols:
            raise UploadError("Nenhuma coluna detectada no arquivo — verifique se o arquivo possui cabeçalho e dados válidos")
        logger.info("%s coluna(s) detectada(s): %s", len(cols), [c.get("originalName", c.get("sqlName", c)) for c in cols[:5]])
        logger.info("Confirmando importação...")

        self._request(
            "POST",
            f"/api/v1/uploads/{upload_id}/confirm",
            json={
                "datasetId": dataset_id,
                "mode": mode,
                "keyColumn": key_column,
                "mapping": cols,
            },
        )

        result = self._wait_upload(upload_id, "COMPLETED", poll_interval)
        logger.info("Upload concluído: %s linha(s) importada(s)", result.get("rowCount", "?"))
        return result

    def _wait_upload(self, upload_id: str, target: str, interval: float):
        last_status = None
        for _ in range(1800):
            upload = self._request("GET", f"/api/v1/uploads/{upload_id}", timeout=None)
            status = upload["status"]
            if status != last_status:
                logger.info("  → %s", status)
                last_status = status
            if status == target:
                return upload
            if status == "FAILED":
                msg = upload.get("errorMessage") or "Falha no processamento do arquivo"
                raise UploadError(msg)
            time.sleep(interval)
        raise QueryTimeoutError("Tempo de processamento do upload excedido")

    def _request(self, method: str, path: str, **kwargs) -> Any:
        try:
            response = self._client.request(method, path, **kwargs)
        except httpx.TimeoutException as exc:
            raise QueryTimeoutError(f"Tempo limite excedido ao conectar com o servidor: {exc}") from exc
        except httpx.HTTPError as exc:
            raise ConnectionError(f"Falha de conexão com o servidor: {exc}") from exc

        if response.is_success:
            return response.json()["data"]

        try:
            body = response.json()
        except Exception:
            body = {}

        error = body.get("error", {})
        code = error.get("code")
        message = error.get("message") or response.text or f"HTTP {response.status_code}"

        logger.debug("Erro da API: [%s] %s", code, message)
        raise from_api_error(code, message)
