from __future__ import annotations

import hashlib as _hashlib
import json as _json
import logging
import zlib as _zlib
from pathlib import Path
from typing import Any, Iterator

import httpx

from .exceptions import (
    ConnectionError,
    QueryTimeoutError,
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
        table_id: str | None = None,
    ):
        file = Path(path)
        if not file.exists():
            raise FileNotFoundError(f"Arquivo não encontrado: {file}")
        size = file.stat().st_size

        logger.info(
            "Iniciando upload: %s (%s) → dataset=%s [modo=%s]",
            file.name, _fmt_bytes(size), dataset_id, mode,
        )

        # Compute MD5 hash streaming (no full-file RAM peak)
        file_hash = self._stream_md5(file)
        logger.debug("Hash MD5: %s", file_hash)

        body: dict = {"filename": file.name, "sizeBytes": size, "fileHash": file_hash, "datasetId": dataset_id, "mode": mode}
        if table_id:
            body["tableId"] = table_id
        if key_column:
            body["keyColumn"] = key_column
        created = self._request("POST", "/api/v1/uploads", json=body)

        if created.get("skip"):
            logger.info("[SKIP] Arquivo inalterado, importação ignorada: %s", file.name)
            return created["upload"]

        upload_id = created["upload"]["id"]

        logger.info("Comprimindo e enviando arquivo para storage...")

        # Stream-compress and upload without loading full file into RAM.
        # Each retry creates a fresh generator from the file. httpx sends via
        # chunked transfer encoding, which Azure Blob Storage supports.
        for attempt in range(3):
            response = self._client.put(
                created["sas"]["url"],
                content=self._gzip_stream(file),
                headers={"content-type": "application/octet-stream", "content-encoding": "gzip"},
                timeout=None,
            )
            if response.status_code != 499 or attempt == 2:
                response.raise_for_status()
                break
            logger.warning("Conexão encerrada pelo servidor (499), tentativa %s/3...", attempt + 1)
            time.sleep(1)

        self._request("POST", f"/api/v1/uploads/{upload_id}?action=uploaded")
        logger.info("Arquivo enviado. Processamento ocorre em background (upload_id=%s)", upload_id)
        return created["upload"]

    @staticmethod
    def _stream_md5(file: Path, chunk_size: int = 1024 * 1024) -> str:
        hasher = _hashlib.md5()
        with file.open("rb") as f:
            while chunk := f.read(chunk_size):
                hasher.update(chunk)
        return hasher.hexdigest()

    @staticmethod
    def _gzip_stream(file: Path, chunk_size: int = 1024 * 1024) -> Iterator[bytes]:
        """Yield gzip-compressed chunks without loading the full file into RAM."""
        compressor = _zlib.compressobj(level=1, wbits=31)  # wbits=31 → gzip format
        with file.open("rb") as f:
            while chunk := f.read(chunk_size):
                compressed = compressor.compress(chunk)
                if compressed:
                    yield compressed
        tail = compressor.flush()
        if tail:
            yield tail

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
