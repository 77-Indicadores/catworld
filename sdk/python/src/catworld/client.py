from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Any

import httpx

from .exceptions import (
    AuthenticationError,
    ConnectionError,
    PermissionDeniedError,
    QueryTimeoutError,
    ValidationError,
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
        logger.debug("Cliente inicializado: base_url=%s timeout=%ss", base_url, timeout)

    def close(self):
        self._client.close()
        logger.debug("Cliente encerrado")

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

    def query(self, sql: str, timeout: int = 30, limit: int = 10000, dataset_id: str | None = None, project_id: str | None = None):
        logger.info("Executando query (timeout=%ss, limit=%s)", timeout, limit)
        payload: dict = {"sql": sql, "timeout": timeout, "limit": limit}
        if dataset_id:
            payload["datasetId"] = dataset_id
        if project_id:
            payload["projectId"] = project_id
        result = self._request("POST", "/api/v1/queries", json=payload, timeout=None)
        logger.info("Query concluída: %s linhas retornadas", len(result) if isinstance(result, list) else "?")
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
        size = file.stat().st_size
        logger.info(
            "Iniciando upload: arquivo=%s tamanho=%s dataset_id=%s modo=%s",
            file.name, _fmt_bytes(size), dataset_id, mode,
        )

        created = self._request(
            "POST",
            "/api/v1/uploads",
            json={"filename": file.name, "sizeBytes": size},
        )
        upload_id = created["upload"]["id"]
        logger.debug("Upload registrado: id=%s", upload_id)

        logger.info("Enviando arquivo para storage: %s (%s)", file.name, _fmt_bytes(size))
        with file.open("rb") as stream:
            response = self._client.put(
                created["sas"]["url"],
                content=stream,
                headers={"content-type": "application/octet-stream"},
                timeout=None,
            )
        response.raise_for_status()
        logger.info("Arquivo enviado com sucesso")

        self._request("POST", f"/api/v1/uploads/{upload_id}/uploaded")
        logger.debug("Notificação de upload enviada, aguardando preview...")

        preview = self._wait(upload_id, "AWAITING_CONFIRMATION", poll_interval)

        import json as _json
        mapping = preview["previewJson"]
        if isinstance(mapping, str):
            mapping = _json.loads(mapping)

        logger.info(
            "Preview gerado: %s colunas detectadas, confirmando importação...",
            len(mapping.get("columns", [])),
        )
        self._request(
            "POST",
            f"/api/v1/uploads/{upload_id}/confirm",
            json={
                "datasetId": dataset_id,
                "mode": mode,
                "keyColumn": key_column,
                "mapping": mapping["columns"],
            },
        )

        result = self._wait(upload_id, "COMPLETED", poll_interval)
        logger.info("Upload concluído: id=%s arquivo=%s", upload_id, file.name)
        return result

    def _wait(self, upload_id: str, target: str, interval: float):
        last_status = None
        for _ in range(1800):
            upload = self._request("GET", f"/api/v1/uploads/{upload_id}", timeout=None)
            status = upload["status"]
            if status != last_status:
                logger.info("Upload %s: status=%s", upload_id, status)
                last_status = status
            else:
                logger.debug("Upload %s: aguardando status=%s (atual=%s)", upload_id, target, status)
            if status == target:
                return upload
            if status == "FAILED":
                msg = upload.get("errorMessage") or "Upload falhou"
                logger.error("Upload %s falhou: %s", upload_id, msg)
                raise ValidationError(msg)
            time.sleep(interval)
        raise QueryTimeoutError("Tempo de processamento excedido")

    def _request(self, method: str, path: str, **kwargs) -> Any:
        logger.debug("→ %s %s", method, path)
        try:
            response = self._client.request(method, path, **kwargs)
        except httpx.HTTPError as exc:
            logger.error("Erro de conexão: %s %s — %s", method, path, exc)
            raise ConnectionError(str(exc)) from exc

        if response.is_success:
            logger.debug("← %s %s %s", method, path, response.status_code)
            return response.json()["data"]

        try:
            body = response.json()
        except Exception:
            body = {}
        message = body.get("error", {}).get("message") or response.text or f"HTTP {response.status_code}"
        logger.warning("← %s %s %s: %s", method, path, response.status_code, message)

        if response.status_code == 401:
            raise AuthenticationError(message)
        if response.status_code == 403:
            raise PermissionDeniedError(message)
        if response.status_code in (400, 422):
            raise ValidationError(message)
        if response.status_code == 408:
            raise QueryTimeoutError(message)
        raise ConnectionError(message)
